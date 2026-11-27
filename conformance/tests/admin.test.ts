import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ADMIN_COOKIE, LOGIN_COOKIE, adminLogin, callbackAdminLogin, postAuthEvent, seedAdminSession, startAdminLogin } from "../harness/admin";
import { nextAddress } from "../harness/apple";
import { startStack, type Stack } from "../harness/stack";
import { sha256Hex } from "../harness/tkp1";

describe("admin auth", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ admin: true });
  });
  afterAll(() => stack?.stop());

  // The admin bucket is 60/min per IP; give the bulkier direct calls their
  // own address so the login-flow tests never trip it.
  const origin = () => stack.anonymous().origin;

  describe("admin off", () => {
    let off: Stack;
    beforeAll(async () => {
      off = await startStack();
    });
    afterAll(() => off?.stop());

    test("without AUTH_* every /api/admin/* and /auth/* route is 404, as if it did not exist", async () => {
      for (const path of ["//api/admin/sources", "//api/admin/synonyms", "//auth/login", "//auth/callback", "//auth/events"]) {
        const result = await off.anonymous().get(path);
        expect(result.status).toBe(404);
        expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
      }
      const logout = await off.anonymous().post("//auth/logout", {});
      expect(logout.status).toBe(404);
    });
  });

  describe("login flow", () => {
    test("GET /auth/login is 302 to the authorize URL with the login cookie", async () => {
      const { authorizeUrl } = await startAdminLogin(stack);
      expect(authorizeUrl).toContain("https://auth.example.test/oauth/authorize");
      expect(authorizeUrl).toContain("client_id=turnip-farm");
      expect(authorizeUrl).toContain("response_type=code");
      expect(authorizeUrl).toContain("max_age=86400");
    });

    test("the callback sets the session cookie and clears the login cookie, and the row is stored", async () => {
      const { client, authorizeUrl } = await startAdminLogin(stack);
      const authorize = new URL(authorizeUrl);
      authorize.protocol = "http:";
      authorize.host = `127.0.0.1:${stack.upstream.auth.port}`;
      const authResponse = await fetch(authorize, { redirect: "manual" });
      expect(authResponse.status).toBe(302);
      const callback = new URL(authResponse.headers.get("location") ?? "");
      const result = await client.get(`//auth/callback${callback.search}`);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/admin");
      const setCookies = result.setCookies.join("\n");
      expect(setCookies).toContain(`${ADMIN_COOKIE}=`);
      expect(setCookies).toContain("Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200");
      expect(setCookies).toContain(`${LOGIN_COOKIE}=;`);
      expect(setCookies).toContain("Max-Age=0");
      const rows = await stack.db.query<{ username: string; role: string; auth_sub: string; auth_sid: string; recheck_at: Date; expires_at: Date; refresh_token: string | null }>(
        `SELECT username, role, auth_sub, auth_sid, recheck_at, expires_at, refresh_token FROM admin_sessions ORDER BY expires_at DESC LIMIT 1`,
        [],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.username).toBe("maintainer");
      expect(rows[0]!.role).toBe("admin");
      expect(rows[0]!.auth_sub).toBe("admin-sub-1");
      expect(rows[0]!.refresh_token).toBeTruthy();
      const now = Date.now();
      expect(rows[0]!.recheck_at.getTime() - now).toBeGreaterThan(590 * 1000);
      expect(rows[0]!.recheck_at.getTime() - now).toBeLessThanOrEqual(600 * 1000);
      expect(rows[0]!.expires_at.getTime() - now).toBeGreaterThan(12 * 60 * 60 * 1000 - 60 * 1000);
    });

    test("a signed-in admin can read the admin list", async () => {
      const client = await adminLogin(stack);
      const result = await client.get("//api/admin/sources");
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toEqual({ sources: [], next_cursor: null });
    });
  });

  describe("callback failures", () => {
    test("a state mismatch is /admin?signin=failed", async () => {
      const { client, authorizeUrl } = await startAdminLogin(stack);
      const authorize = new URL(authorizeUrl);
      authorize.protocol = "http:";
      authorize.host = `127.0.0.1:${stack.upstream.auth.port}`;
      authorize.searchParams.set("state", "tampered");
      const authResponse = await fetch(authorize, { redirect: "manual" });
      const callback = new URL(authResponse.headers.get("location") ?? "");
      const result = await client.get(`//auth/callback${callback.search}`);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/admin?signin=failed");
      expect(client.cookies.has(ADMIN_COOKIE)).toBe(false);
    });

    test("a callback with no code is /admin?signin=failed", async () => {
      const { client, authorizeUrl } = await startAdminLogin(stack);
      const state = new URL(authorizeUrl).searchParams.get("state");
      const result = await client.get(`//auth/callback?state=${state}`);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/admin?signin=failed");
    });

    test("a non-admin role is /admin?signin=forbidden and the refresh token is revoked", async () => {
      const revokedBefore = stack.upstream.auth.revoked.length;
      stack.upstream.auth.state.role = "viewer";
      try {
        const { client, authorizeUrl } = await startAdminLogin(stack);
        const result = await callbackAdminLogin(stack, client, authorizeUrl);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe("/admin?signin=forbidden");
        expect(client.cookies.has(ADMIN_COOKIE)).toBe(false);
      } finally {
        stack.upstream.auth.state.role = "admin";
      }
      expect(stack.upstream.auth.revoked.length).toBe(revokedBefore + 1);
      // The forbidden login left no session behind.
      const rows = await stack.db.query(`SELECT 1 FROM admin_sessions WHERE role = 'viewer'`);
      expect(rows).toHaveLength(0);
    });

    test("a sign-in without mfa is /admin?signin=mfa_required and the refresh token is revoked", async () => {
      const revokedBefore = stack.upstream.auth.revoked.length;
      stack.upstream.auth.state.amr = [];
      try {
        const { client, authorizeUrl } = await startAdminLogin(stack);
        const result = await callbackAdminLogin(stack, client, authorizeUrl);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe("/admin?signin=mfa_required");
        expect(client.cookies.has(ADMIN_COOKIE)).toBe(false);
      } finally {
        stack.upstream.auth.state.amr = ["mfa"];
      }
      expect(stack.upstream.auth.revoked.length).toBe(revokedBefore + 1);
    });

    test("auth down at login is /admin?signin=unavailable", async () => {
      // Discovery is cached forever per server process, so this needs a
      // fresh stack whose first login hits auth while it is down.
      const fresh = await startStack({ admin: true });
      try {
        fresh.upstream.auth.setUnreachable(true);
        const result = await fresh.anonymous().get("//auth/login");
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe("/admin?signin=unavailable");
      } finally {
        fresh.upstream.auth.setUnreachable(false);
        await fresh.stop();
      }
    });

    test("a provider error at the callback is /admin?signin=failed", async () => {
      const { client, authorizeUrl } = await startAdminLogin(stack);
      const state = new URL(authorizeUrl).searchParams.get("state");
      const result = await client.get(`//auth/callback?error=access_denied&state=${state}`);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/admin?signin=failed");
      expect(client.cookies.has(ADMIN_COOKIE)).toBe(false);
    });

    test("an auth_time older than max_age is /admin?signin=failed", async () => {
      stack.upstream.auth.state.authTimeAgeSec = 90000;
      try {
        const { client, authorizeUrl } = await startAdminLogin(stack);
        const result = await callbackAdminLogin(stack, client, authorizeUrl);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe("/admin?signin=failed");
        expect(client.cookies.has(ADMIN_COOKIE)).toBe(false);
      } finally {
        stack.upstream.auth.state.authTimeAgeSec = 0;
      }
    });
  });

  describe("sessions", () => {
    test("no cookie, a malformed cookie, an unknown token, and an expired session are all 401", async () => {
      const expected = {
        error: { code: "UNAUTHENTICATED", message: "Sign in at /auth/login", details: {} },
      };
      const address = nextAddress();
      const noCookie = await stack.anonymous().get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
      expect(noCookie.status).toBe(401);
      expect(noCookie.json).toEqual(expected);
      expect(noCookie.headers.get("cache-control")).toBe("no-store");
      const malformed = stack.anonymous();
      malformed.cookies.set(ADMIN_COOKIE, "not-a-token");
      const malformedResult = await malformed.get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
      expect(malformedResult.status).toBe(401);
      const unknown = stack.anonymous();
      unknown.cookies.set(ADMIN_COOKIE, "A".repeat(43));
      const unknownResult = await unknown.get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
      expect(unknownResult.status).toBe(401);
      const expired = await seedAdminSession(stack, { expiresInSec: -60 });
      const expiredResult = await expired.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
      expect(expiredResult.status).toBe(401);
    });

    test("GET /api/admin/session answers 200 {username, role} for a signed-in admin", async () => {
      const { client } = await seedAdminSession(stack, {});
      const result = await client.get("//api/admin/session", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ username: "maintainer", role: "admin" });
      expect(result.headers.get("cache-control")).toBe("no-store");
    });

    test("GET /api/admin/session is 401 with no cookie or an unknown token", async () => {
      const expected = {
        error: { code: "UNAUTHENTICATED", message: "Sign in at /auth/login", details: {} },
      };
      const noCookie = await stack.anonymous().get("//api/admin/session", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(noCookie.status).toBe(401);
      expect(noCookie.json).toEqual(expected);
      const unknown = stack.anonymous();
      unknown.cookies.set(ADMIN_COOKIE, "A".repeat(43));
      const unknownResult = await unknown.get("//api/admin/session", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(unknownResult.status).toBe(401);
      expect(unknownResult.json).toEqual(expected);
    });

    test("a stored non-admin role is 401", async () => {
      const { client } = await seedAdminSession(stack, { role: "viewer" });
      const result = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(401);
      expect(result.json).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Sign in at /auth/login", details: {} },
      });
    });

    test("a write without the farm Origin is 403 before any session lookup; a GET needs no Origin", async () => {
      const address = nextAddress();
      const { client } = await seedAdminSession(stack, {});
      // With a valid session, still 403 without Origin.
      const noOrigin = await client.put("//api/admin/sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/holdout", {}, { headers: { "X-Forwarded-For": address } });
      expect(noOrigin.status).toBe(403);
      expect(noOrigin.json).toEqual({
        error: { code: "FORBIDDEN", message: "Admin writes must come from the farm's own pages", details: {} },
      });
      // Without a session at all, still 403 (Origin is checked first).
      const anonNoOrigin = await stack.anonymous().put("//api/admin/sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/holdout", {}, { headers: { "X-Forwarded-For": address } });
      expect(anonNoOrigin.status).toBe(403);
      // A wrong Origin is 403 too.
      const wrongOrigin = await client.put("//api/admin/sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/holdout", {}, { headers: { Origin: "https://evil.example", "X-Forwarded-For": address } });
      expect(wrongOrigin.status).toBe(403);
      // The farm's own Origin proceeds to the session check (404: no such source).
      const ownOrigin = await client.put("//api/admin/sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/holdout", {}, { headers: { Origin: origin(), "X-Forwarded-For": address } });
      expect(ownOrigin.status).toBe(404);
      // GETs need no Origin.
      const get = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
      expect(get.status).toBe(200);
    });
  });

  describe("logout", () => {
    test("without Origin is 403; without a cookie is 303 /admin with the cookie cleared", async () => {
      const address = nextAddress();
      const { client } = await seedAdminSession(stack, {});
      const noOrigin = await client.post("//auth/logout", {}, { headers: { "X-Forwarded-For": address } });
      expect(noOrigin.status).toBe(403);
      expect(noOrigin.json).toEqual({
        error: { code: "FORBIDDEN", message: "Sign out from the farm's own pages", details: {} },
      });
      const noCookie = await stack.anonymous().post("//auth/logout", {}, { headers: { Origin: origin(), "X-Forwarded-For": address } });
      expect(noCookie.status).toBe(303);
      expect(noCookie.headers.get("location")).toBe("/admin");
      expect(noCookie.setCookies.join("\n")).toContain(`${ADMIN_COOKIE}=;`);
      expect(noCookie.setCookies.join("\n")).toContain("Max-Age=0");
    });

    test("with a session it 303s to auth's end-session URL, clears the cookie, deletes the row, and revokes the refresh token", async () => {
      const client = await adminLogin(stack);
      const token = client.cookies.get(ADMIN_COOKIE)!;
      const tokenHash = await sha256Hex(new TextEncoder().encode(token));
      const revokedBefore = stack.upstream.auth.revoked.length;
      const before = await stack.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
      expect(before?.n).toBe(1);
      const result = await client.post("//auth/logout", {}, { headers: { Origin: origin(), "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(303);
      expect(result.headers.get("location")).toContain("https://auth.example.test/logout");
      expect(result.headers.get("location")).toContain("post_logout_redirect_uri=");
      expect(result.setCookies.join("\n")).toContain(`${ADMIN_COOKIE}=;`);
      const after = await stack.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
      expect(after?.n).toBe(0);
      expect(stack.upstream.auth.revoked.length).toBeGreaterThan(revokedBefore);
      // The session is gone: the same client is 401 now.
      const gone = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(gone.status).toBe(401);
    });
  });

  describe("events", () => {
    test("session.ended deletes the session by sid; user.disabled and user.deleted delete by sub", async () => {
      const first = await seedAdminSession(stack, { authSub: "sub-a", authSid: "sid-a" });
      const second = await seedAdminSession(stack, { authSub: "sub-a", authSid: "sid-b" });
      const third = await seedAdminSession(stack, { authSub: "sub-c", authSid: "sid-c" });
      expect(await postAuthEvent(stack, stack.upstream.auth.event("session.ended", { sid: "sid-a" }))).toBe(204);
      expect(await first.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 401 });
      expect(await second.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 200 });
      expect(await postAuthEvent(stack, stack.upstream.auth.event("user.disabled", { sub: "sub-a" }))).toBe(204);
      expect(await second.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 401 });
      expect(await third.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 200 });
      expect(await postAuthEvent(stack, stack.upstream.auth.event("user.deleted", { sub: "sub-c" }))).toBe(204);
      expect(await third.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 401 });
    });

    test("access.changed to admin updates the row; to another role deletes it; an unknown type is a 204 no-op", async () => {
      const first = await seedAdminSession(stack, { authSub: "sub-x", role: "viewer" });
      expect(await postAuthEvent(stack, stack.upstream.auth.event("access.changed", { sub: "sub-x", role: "admin" }))).toBe(204);
      const promoted = await first.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(promoted.status).toBe(200);
      expect(await postAuthEvent(stack, stack.upstream.auth.event("access.changed", { sub: "sub-x", role: "viewer" }))).toBe(204);
      expect(await first.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 401 });
      expect(await postAuthEvent(stack, stack.upstream.auth.event("something.else", { sub: "sub-x" }))).toBe(204);
    });

    test("a malformed event is 422, an oversized one is 422, and events are idempotent", async () => {
      const malformed = await postAuthEvent(stack, "not-a-jwt");
      expect(malformed).toBe(422);
      const big = await stack.anonymous().request("POST", "//auth/events", {
        rawBody: "x".repeat(64 * 1024 + 1),
        headers: { "Content-Type": "text/plain" },
      });
      expect(big.status).toBe(422);
      expect(big.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "Event too large", details: {} },
      });
      const { client } = await seedAdminSession(stack, { authSid: "sid-repeat" });
      const event = stack.upstream.auth.event("session.ended", { sid: "sid-repeat" });
      expect(await postAuthEvent(stack, event)).toBe(204);
      expect(await postAuthEvent(stack, event)).toBe(204);
      expect(await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } })).toMatchObject({ status: 401 });
    });

    test("auth down while verifying is 503", async () => {
      // The JWKS is cached for an hour, so this needs a fresh stack whose
      // first event verification hits auth while it is down.
      const fresh = await startStack({ admin: true });
      try {
        fresh.upstream.auth.setUnreachable(true);
        const status = await postAuthEvent(fresh, fresh.upstream.auth.event("session.ended", { sid: "sid-down" }));
        expect(status).toBe(503);
      } finally {
        fresh.upstream.auth.setUnreachable(false);
        await fresh.stop();
      }
    });
  });

  describe("re-check", () => {
    /** The token_hash of a signed-in client's session row. */
    const tokenHashOf = async (client: { cookies: Map<string, string> }): Promise<string> =>
      sha256Hex(new TextEncoder().encode(client.cookies.get(ADMIN_COOKIE)!));

    test("a due session refreshes: the row's verified_at moves and recheck_at stays in the future", async () => {
      const client = await adminLogin(stack);
      const tokenHash = await tokenHashOf(client);
      const before = await stack.db.one<{ recheck_at: Date; verified_at: Date }>(
        `SELECT recheck_at, verified_at FROM admin_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      await stack.db.query(`UPDATE admin_sessions SET recheck_at = now() - interval '1 minute' WHERE token_hash = $1`, [tokenHash]);
      const result = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(200);
      const after = await stack.db.one<{ recheck_at: Date; verified_at: Date; username: string; role: string }>(
        `SELECT recheck_at, verified_at, username, role FROM admin_sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      // The refresh runs (verified_at moves to now) and the next re-check
      // is the new access token's expiry, in the future. recheck_at itself
      // is second-precision, so it need not strictly increase when the
      // login and the refresh fall in the same second.
      expect(after!.verified_at.getTime()).toBeGreaterThan(before!.verified_at.getTime());
      expect(after!.recheck_at.getTime()).toBeGreaterThanOrEqual(before!.recheck_at.getTime());
      expect(after!.recheck_at.getTime()).toBeGreaterThan(Date.now());
      expect(after!.username).toBe("maintainer");
      expect(after!.role).toBe("admin");
    });

    test("a refresh that finds a non-admin role is 401 and the session is deleted", async () => {
      const client = await adminLogin(stack);
      const tokenHash = await tokenHashOf(client);
      await stack.db.query(`UPDATE admin_sessions SET recheck_at = now() - interval '1 minute' WHERE token_hash = $1`, [tokenHash]);
      stack.upstream.auth.state.role = "viewer";
      try {
        const result = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
        expect(result.status).toBe(401);
      } finally {
        stack.upstream.auth.state.role = "admin";
      }
      const rows = await stack.db.query(`SELECT 1 FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
      expect(rows).toHaveLength(0);
    });

    test("a refresh with an unknown refresh token (invalid_grant) is 401 and the session is deleted", async () => {
      const client = await adminLogin(stack);
      const tokenHash = await tokenHashOf(client);
      await stack.db.query(`UPDATE admin_sessions SET recheck_at = now() - interval '1 minute', refresh_token = 'no-such-token' WHERE token_hash = $1`, [tokenHash]);
      const result = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(401);
      const rows = await stack.db.query(`SELECT 1 FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
      expect(rows).toHaveLength(0);
    });

    test("a due session with no refresh token is 401 and deleted", async () => {
      const { client, token } = await seedAdminSession(stack, { refreshToken: null, recheckInSec: -60 });
      const tokenHash = await sha256Hex(new TextEncoder().encode(token));
      const result = await client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
      expect(result.status).toBe(401);
      const rows = await stack.db.query(`SELECT 1 FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
      expect(rows).toHaveLength(0);
    });

    test("auth down with a fresh verified_at passes through; with a stale one it is 503", async () => {
      const fresh = await adminLogin(stack);
      const freshHash = await tokenHashOf(fresh);
      await stack.db.query(`UPDATE admin_sessions SET recheck_at = now() - interval '1 minute' WHERE token_hash = $1`, [freshHash]);
      stack.upstream.auth.setUnreachable(true);
      try {
        const ok = await fresh.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
        expect(ok.status).toBe(200);
      } finally {
        stack.upstream.auth.setUnreachable(false);
      }
      const stale = await seedAdminSession(stack, {
        refreshToken: "some-token",
        recheckInSec: -60,
        verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });
      stack.upstream.auth.setUnreachable(true);
      try {
        const blocked = await stale.client.get("//api/admin/sources", { headers: { "X-Forwarded-For": nextAddress() } });
        expect(blocked.status).toBe(503);
        expect(blocked.json).toEqual({
          error: { code: "AUTH_UNAVAILABLE", message: "The sign-in service is unreachable; retry later", details: {} },
        });
      } finally {
        stack.upstream.auth.setUnreachable(false);
      }
    });
  });
});
