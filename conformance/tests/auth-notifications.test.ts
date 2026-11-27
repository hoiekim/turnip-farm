import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, nextAddress, randomSub, signIn, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedConsent, seedSource, seedSession, seedStagedBlob } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";

const VALIDATION = { error: { code: "VALIDATION_ERROR", message: "payload must be a non-empty string", details: {} } };

describe("auth-notifications", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  const notify = (payload: unknown, forwardedFor = nextAddress()) =>
    stack.anonymous().post("/auth/apple/notifications", { payload }, { headers: { "X-Forwarded-For": forwardedFor } });

  const payloadFor = (sub: string, type: string, events?: unknown) =>
    stack.upstream.apple.notificationPayload({
      claims: { events: events ?? { type, sub } },
    });

  test("validation: missing, non-string, or empty payload is 422", async () => {
    for (const body of [{}, { payload: 42 }, { payload: "" }, { payload: null }]) {
      const result = await stack.anonymous().post("/auth/apple/notifications", body, {
        headers: { "X-Forwarded-For": nextAddress() },
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual(VALIDATION);
    }
  });

  test("a forged, HS256, or malformed payload is 401", async () => {
    const sub = randomSub();
    const forged = await stack.upstream.apple.notificationPayload({
      key: new Uint8Array(32),
      claims: { events: { type: "consent-revoked", sub } },
    });
    const badKey = await (async () => {
      const { generateKeyPair } = await import("jose");
      const pair = await generateKeyPair("RS256", { extractable: true });
      return stack.upstream.apple.notificationPayload({ key: pair.privateKey, claims: { events: { type: "consent-revoked", sub } } });
    })();
    for (const payload of [forged, badKey, "not-a-jwt", "a.b.c"]) {
      const result = await notify(payload);
      expect(result.status).toBe(401);
      expect(result.json).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Invalid notification signature", details: {} },
      });
    }
  });

  test("unknown event type, unknown sub, and events without type/sub are 200 no-ops", async () => {
    const { userId } = await seedSession(stack, randomSub());
    for (const events of [
      { type: "something-new", sub: userId },
      { type: "consent-revoked", sub: "no-such-user" },
      { type: "consent-revoked" },
      { sub: userId },
      {},
    ]) {
      const result = await notify(await payloadFor(userId, "consent-revoked", events));
      expect(result.status).toBe(200);
    }
    // The seeded user is untouched.
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [userId]);
    expect(user).toBeDefined();
  });

  test("events as a JSON string are accepted, like events as an object", async () => {
    const { userId } = await signIn(stack, randomSub());
    const result = await notify(
      await payloadFor(userId, "consent-revoked", JSON.stringify({ type: "consent-revoked", sub: userId })),
    );
    expect(result.status).toBe(200);
    const sessions = await stack.db.query(`SELECT id FROM sessions WHERE user_id = $1`, [userId]);
    expect(sessions).toHaveLength(0);
  });

  test("consent-revoked: sessions deleted, refresh token cleared, contributions stay", async () => {
    const { userId, client } = await signIn(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`notify-consent-${userId}`);
    await seedSource(stack, sourceId, { userId });
    const result = await notify(await payloadFor(userId, "consent-revoked"));
    expect(result.status).toBe(200);
    const sessions = await stack.db.query(`SELECT id FROM sessions WHERE user_id = $1`, [userId]);
    expect(sessions).toHaveLength(0);
    const user = await stack.db.one<{ apple_refresh_token: unknown }>(
      `SELECT apple_refresh_token FROM users WHERE id = $1`,
      [userId],
    );
    expect(user?.apple_refresh_token).toBeNull();
    const source = await stack.db.one(`SELECT id FROM sources WHERE id = $1`, [sourceId]);
    expect(source).toBeDefined();
  });

  test("account-deleted: everything is gone, both R2 blobs deleted, Apple revoke NOT called", async () => {
    const { userId, client } = await signIn(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`notify-delete-${userId}`);
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, { userId, canonicalBytes: staged });
    await seedStagedBlob(stack, sourceId, staged);
    const clipId = await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
    await seedConsent(stack, userId, 3);
    expect(stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)).toBeDefined();
    expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeDefined();
    const revokeBefore = stack.upstream.apple.revokeRequests.length;
    const result = await notify(await payloadFor(userId, "account-deleted"));
    expect(result.status).toBe(200);
    expect(stack.upstream.apple.revokeRequests.length).toBe(revokeBefore);
    for (const [table, where] of [
      ["users", `id = '${userId}'`],
      ["sessions", `user_id = '${userId}'`],
      ["consents", `user_id = '${userId}'`],
      ["source_attribution", `user_id = '${userId}'`],
      ["sources", `id = '${sourceId}'`],
      ["clips", `id = '${clipId}'`],
    ] as const) {
      const rows = await stack.db.query(`SELECT 1 FROM ${table} WHERE ${where}`);
      expect(rows).toHaveLength(0);
    }
    expect(stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)).toBeUndefined();
    expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeUndefined();
  });

  test("email-enabled / email-disabled are 200 and change nothing", async () => {
    const { userId } = await signIn(stack, randomSub());
    for (const type of ["email-enabled", "email-disabled"]) {
      const result = await notify(await payloadFor(userId, type));
      expect(result.status).toBe(200);
    }
    const sessions = await stack.db.query(`SELECT id FROM sessions WHERE user_id = $1`, [userId]);
    expect(sessions).toHaveLength(1);
  });

  test("an R2 delete failure during account-deleted is 500 and the rows survive", async () => {
    const { userId, client } = await signIn(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`notify-r2fail-${userId}`);
    await seedSource(stack, sourceId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
    stack.upstream.r2.failNext("DELETE", 500);
    const result = await notify(await payloadFor(userId, "account-deleted"));
    expect(result.status).toBe(500);
    expect(result.json).toEqual({
      error: { code: "INTERNAL", message: "Could not delete the account data; retry later", details: {} },
    });
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [userId]);
    expect(user).toBeDefined();
    // Retry succeeds.
    const retry = await notify(await payloadFor(userId, "account-deleted"));
    expect(retry.status).toBe(200);
    const gone = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [userId]);
    expect(gone).toBeUndefined();
  });

  test("rate limit: notifications share the 10/min IP bucket with sign-in", async () => {
    const address = "10.8.8.8";
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      // A forged payload still counts: the bucket is taken before the handler runs.
      const result = await notify("garbage", address);
      results.push(result.status);
    }
    expect(results.slice(0, 10)).toEqual(new Array(10).fill(401));
    expect(results[10]).toBe(429);
  });

  describe("JWKS down on a fresh stack", () => {
    test("a JWKS outage is 500", async () => {
      const fresh = await startStack();
      try {
        fresh.upstream.hub.setDown("appleid.apple.com", true);
        const payload = await fresh.upstream.apple.notificationPayload({
          claims: { events: { type: "consent-revoked", sub: randomSub() } },
        });
        const result = await fresh.anonymous().post(
          "/auth/apple/notifications",
          { payload },
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
