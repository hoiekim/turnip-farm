import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPair, jwtVerify } from "jose";
import { APP_BUNDLE_ID, APPLE_KEY_ID, APPLE_TEAM_ID, APPLE_ISSUER, getFarmAppleKey } from "../harness/config";
import { nextAddress, randomSub, sha256Hex, signIn } from "../harness/apple";
import { startStack, type Stack } from "../harness/stack";

const VALIDATION = { error: { code: "VALIDATION_ERROR", message: "identity_token, authorization_code, and nonce must be non-empty strings", details: {} } };
const UNAUTHENTICATED = { error: { code: "UNAUTHENTICATED", message: "Sign in with Apple failed", details: {} } };

describe("auth-apple", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());

  /** Posts a sign-in attempt without asserting success. */
  const attempt = (body: unknown, forwardedFor = nextAddress()) =>
    stack.anonymous().post("/auth/apple", body, { headers: { "X-Forwarded-For": forwardedFor } });

  // Every attempt below posts nonce "raw-nonce", so identity tokens carry
  // its hash unless the test overrides the nonce claim.
  const identityToken = async (sub: string, claims: Record<string, unknown> = {}) =>
    stack.upstream.apple.identityToken({
      sub,
      claims: { nonce: await sha256Hex(new TextEncoder().encode("raw-nonce")), ...claims },
    });

  test("validation: non-object, array, string, and empty bodies are 422", async () => {
    for (const body of [null, [], "x", 42, {}]) {
      const result = await stack.anonymous().request("POST", "/auth/apple", {
        body: body === null ? undefined : body,
        rawBody: body === null ? "" : undefined,
        headers: { "X-Forwarded-For": nextAddress() },
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual(VALIDATION);
    }
  });

  test("validation: each missing, empty, or non-string field is 422", async () => {
    const sub = randomSub();
    const good = {
      identity_token: await identityToken(sub),
      authorization_code: stack.upstream.apple.issueCode(sub),
      nonce: "raw-nonce",
    };
    for (const field of ["identity_token", "authorization_code", "nonce"] as const) {
      for (const bad of [undefined, "", 42]) {
        const result = await attempt({ ...good, [field]: bad });
        expect(result.status).toBe(422);
        expect(result.json).toEqual(VALIDATION);
      }
    }
  });

  test("nonce mismatch is 401", async () => {
    const sub = randomSub();
    const result = await attempt({
      identity_token: await stack.upstream.apple.identityToken({
        sub,
        claims: { nonce: await sha256Hex(new TextEncoder().encode("another-nonce")) },
      }),
      authorization_code: stack.upstream.apple.issueCode(sub),
      nonce: "raw-nonce",
    });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(UNAUTHENTICATED);
    expect(result.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("an exchanged id_token naming another sub is 401", async () => {
    const subA = randomSub();
    const subB = randomSub();
    const result = await attempt({
      identity_token: await identityToken(subB),
      authorization_code: stack.upstream.apple.issueCode(subA),
      nonce: "raw-nonce",
    });
    expect(result.status).toBe(401);
    expect(result.json).toEqual(UNAUTHENTICATED);
  });

  test("bad identity tokens are 401: expired, wrong iss, wrong aud, HS256, unknown kid, malformed", async () => {
    const sub = randomSub();
    const now = Math.floor(Date.now() / 1000);
    const cases: { name: string; token: string | Promise<string> }[] = [
      { name: "expired", token: identityToken(sub, { exp: now - 120 }) },
      { name: "wrong iss", token: identityToken(sub, { iss: "https://evil.example.test" }) },
      { name: "wrong aud", token: identityToken(sub, { aud: "other-bundle" }) },
      { name: "HS256", token: stack.upstream.apple.identityToken({ sub, key: new Uint8Array(32) }) },
      { name: "unknown kid", token: (async () => {
        const pair = await generateKeyPair("RS256", { extractable: true });
        return stack.upstream.apple.identityToken({ sub, kid: "k2", key: pair.privateKey });
      })() },
      { name: "malformed", token: "not-a-jwt" },
    ];
    for (const { name, token } of cases) {
      const result = await attempt({
        identity_token: await token,
        authorization_code: stack.upstream.apple.issueCode(sub),
        nonce: "raw-nonce",
      });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(UNAUTHENTICATED);
    }
  });

  test("success: 200 with a session token, a users row, and a sessions row; expired sessions purged", async () => {
    const sub = randomSub();
    // An expired session of the same user, purged in the sign-in transaction.
    await stack.db.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [sub],
    );
    await stack.db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 hour')`,
      [sub, "0".repeat(64)],
    );
    const { client, sessionToken } = await signIn(stack, sub);
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const user = await stack.db.one<{ id: string; apple_refresh_token: Buffer | null }>(
      `SELECT id, apple_refresh_token FROM users WHERE id = $1`,
      [sub],
    );
    expect(user?.id).toBe(sub);
    expect(user?.apple_refresh_token).not.toBeNull();
    expect(Buffer.isBuffer(user?.apple_refresh_token)).toBe(true);
    const session = await stack.db.one<{ token_hash: string; expires_at: Date }>(
      `SELECT token_hash, expires_at FROM sessions WHERE user_id = $1`,
      [sub],
    );
    expect(session?.token_hash).toBe(await sha256Hex(new TextEncoder().encode(sessionToken)));
    const expiresMs = new Date(session!.expires_at).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(90 * 24 * 60 * 60 * 1000);
    // The expired session is gone; the new one remains.
    const sessions = await stack.db.query(`SELECT token_hash FROM sessions WHERE user_id = $1`, [sub]);
    expect(sessions).toHaveLength(1);
    expect(client.bearer).toBe(sessionToken);
  });

  test("re-sign-in rotates the stored refresh token; the old session still works", async () => {
    const sub = randomSub();
    const first = await signIn(stack, sub);
    const before = await stack.db.one<{ apple_refresh_token: Buffer }>(
      `SELECT apple_refresh_token FROM users WHERE id = $1`,
      [sub],
    );
    const second = await signIn(stack, sub);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    const after = await stack.db.one<{ apple_refresh_token: Buffer }>(
      `SELECT apple_refresh_token FROM users WHERE id = $1`,
      [sub],
    );
    expect(Buffer.compare(before!.apple_refresh_token, after!.apple_refresh_token)).not.toBe(0);
    // The old session still authenticates.
    const result = await first.client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(result.status).toBe(204);
  });

  test("a blocked user still gets a session; other endpoints answer 403 ACCOUNT_BLOCKED", async () => {
    const sub = randomSub();
    await stack.db.query(`INSERT INTO users (id, is_blocked) VALUES ($1, true)`, [sub]);
    const { client } = await signIn(stack, sub);
    const result = await client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(result.status).toBe(403);
    expect(result.json).toEqual({
      error: { code: "ACCOUNT_BLOCKED", message: "Account blocked", details: {} },
    });
  });

  test("the fake Apple saw a valid ES256 client secret", async () => {
    const sub = randomSub();
    await signIn(stack, sub);
    const forms = stack.upstream.apple.tokenForms();
    expect(forms.length).toBeGreaterThan(0);
    const form = forms[forms.length - 1]!;
    expect(form.client_id).toBe(APP_BUNDLE_ID);
    expect(form.grant_type).toBe("authorization_code");
    const secret = form.client_secret!;
    const [headerB64, payloadB64] = secret.split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(APPLE_KEY_ID);
    expect(payload.iss).toBe(APPLE_TEAM_ID);
    expect(payload.sub).toBe(APP_BUNDLE_ID);
    expect(payload.aud).toBe(APPLE_ISSUER);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
    const { publicKey } = await getFarmAppleKey();
    await jwtVerify(secret, publicKey, { issuer: APPLE_TEAM_ID, audience: APPLE_ISSUER, algorithms: ["ES256"] });
  });

  test("rate limit: 11 sign-ins from one address, the 11th is 429; another address is unaffected", async () => {
    const address = "10.9.9.9";
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const sub = randomSub();
      const result = await attempt(
        {
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        },
        address,
      );
      results.push(result.status);
    }
    // The first ten succeed (each with a fresh sub); the eleventh is rate limited.
    expect(results.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(results[10]).toBe(429);
    const sub = randomSub();
    const last = await attempt(
      {
        identity_token: await identityToken(sub),
        authorization_code: stack.upstream.apple.issueCode(sub),
        nonce: "raw-nonce",
      },
      address,
    );
    expect(last.status).toBe(429);
    expect(last.json).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests", details: {} } });
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // A different address is unaffected.
    const other = await signIn(stack, randomSub(), { forwardedFor: "10.9.9.10" });
    expect(other.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  describe("token endpoint failures", () => {
    test("5xx is 503 APPLE_UNAVAILABLE", async () => {
      const sub = randomSub();
      const restore = stack.upstream.apple.state.token;
      stack.upstream.apple.state.token = () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      try {
        const result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(503);
        expect(result.json).toEqual({
          error: { code: "APPLE_UNAVAILABLE", message: "Sign in with Apple is unavailable; retry later", details: {} },
        });
      } finally {
        stack.upstream.apple.state.token = restore;
      }
    });

    test("invalid_grant is 401", async () => {
      const sub = randomSub();
      const result = await attempt({
        identity_token: await identityToken(sub),
        authorization_code: "bogus-code",
        nonce: "raw-nonce",
      });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(UNAUTHENTICATED);
    });

    test("invalid_client is 500 (misconfiguration)", async () => {
      const sub = randomSub();
      const restore = stack.upstream.apple.state.token;
      stack.upstream.apple.state.token = () =>
        new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 });
      try {
        const result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(500);
        expect(result.json).toEqual({
          error: { code: "INTERNAL", message: "Internal server error", details: {} },
        });
      } finally {
        stack.upstream.apple.state.token = restore;
      }
    });

    test("a non-JSON answer, or one without id_token or refresh_token, is 500", async () => {
      const sub = randomSub();
      const restore = stack.upstream.apple.state.token;
      try {
        stack.upstream.apple.state.token = () => new Response("not json", { status: 200 });
        let result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(500);
        stack.upstream.apple.state.token = () =>
          new Response(JSON.stringify({ refresh_token: "x" }), { status: 200 });
        result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(500);
        stack.upstream.apple.state.token = async () =>
          new Response(JSON.stringify({ id_token: await identityToken(sub) }), { status: 200 });
        result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(500);
      } finally {
        stack.upstream.apple.state.token = restore;
      }
    });

    test("an unreachable token endpoint is 503 (JWKS cached from the earlier sign-in)", async () => {
      const sub = randomSub();
      // A successful sign-in first, so the JWKS is cached in this process.
      await signIn(stack, randomSub());
      stack.upstream.hub.setDown("appleid.apple.com", true);
      try {
        const result = await attempt({
          identity_token: await identityToken(sub),
          authorization_code: stack.upstream.apple.issueCode(sub),
          nonce: "raw-nonce",
        });
        expect(result.status).toBe(503);
        expect(result.json).toEqual({
          error: { code: "APPLE_UNAVAILABLE", message: "Sign in with Apple is unavailable; retry later", details: {} },
        });
      } finally {
        stack.upstream.hub.setDown("appleid.apple.com", false);
      }
    });
  });

  describe("JWKS down on a fresh stack", () => {
    test("a JWKS outage is the farm's fault: 500 INTERNAL", async () => {
      // A fresh stack (a fresh server process): jose has no cached key set,
      // so the JWKS fetch failure surfaces as 500, not 401.
      const fresh = await startStack();
      try {
        fresh.upstream.hub.setDown("appleid.apple.com", true);
        const sub = randomSub();
        const result = await fresh.anonymous().post(
          "/auth/apple",
          {
            identity_token: await fresh.upstream.apple.identityToken({ sub }),
            authorization_code: fresh.upstream.apple.issueCode(sub),
            nonce: "raw-nonce",
          },
          { headers: { "X-Forwarded-For": nextAddress() } },
        );
        expect(result.status).toBe(500);
        expect(result.json).toEqual({
          error: { code: "INTERNAL", message: "Internal server error", details: {} },
        });
      } finally {
        await fresh.stop();
      }
    });
  });
});
