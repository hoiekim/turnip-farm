/**
 * The admin flow driver: the OIDC login dance through FakeAuth, and the
 * fast path that seeds an `admin_sessions` row directly.
 *
 * Most admin tests seed a session (the row carries everything the
 * endpoint checks); the full flow lives in admin.test.ts. A seeded
 * session has `recheck_at` in the future, so no refresh runs — tests
 * that need the refresh path must sign in for real, then move the row's
 * `recheck_at` / `verified_at` with SQL.
 */
import { randomBytes } from "node:crypto";
import type { ApiClient } from "./client";
import type { Stack } from "./stack";
import { sha256Hex } from "./tkp1";

export const ADMIN_COOKIE = "__Host-turnip-admin";
export const LOGIN_COOKIE = "__Host-login";

/** Starts the login: GET /auth/login → 302 to the fake's authorize URL + the login cookie. */
export const startAdminLogin = async (
  stack: Stack,
  client: ApiClient = stack.anonymous(),
): Promise<{ client: ApiClient; authorizeUrl: string }> => {
  const result = await client.get("//auth/login");
  if (result.status !== 302) throw new Error(`GET /auth/login answered ${result.status}: ${result.text}`);
  const location = result.headers.get("location");
  if (!location) throw new Error("GET /auth/login answered 302 without a Location");
  if (!client.cookies.has(LOGIN_COOKIE)) throw new Error("GET /auth/login set no login cookie");
  return { client, authorizeUrl: location };
};

/**
 * Follows the authorize URL through the fake (its origin rewritten to
 * the fake's local port), then GETs the farm's /auth/callback with the
 * login cookie. Returns the callback's raw answer, so a test can assert
 * the failure redirect itself instead of only noticing that no session
 * cookie was set.
 */
export const callbackAdminLogin = async (stack: Stack, client: ApiClient, authorizeUrl: string) => {
  const authorize = new URL(authorizeUrl);
  authorize.protocol = "http:";
  authorize.host = `127.0.0.1:${stack.upstream.auth.port}`;
  const authResponse = await fetch(authorize, { redirect: "manual" });
  if (authResponse.status !== 302) {
    throw new Error(`authorize answered ${authResponse.status}: ${await authResponse.text()}`);
  }
  const callback = new URL(authResponse.headers.get("location") ?? "");
  // The callback is on the farm's own origin; the path + query carry the code and state.
  return client.get(`//auth/callback${callback.search}`);
};

/**
 * Finishes the login: follows the authorize URL through the fake (its
 * origin rewritten to the fake's local port), then GETs the farm's
 * /auth/callback with the login cookie. Returns the client carrying the
 * admin session cookie.
 */
export const finishAdminLogin = async (stack: Stack, client: ApiClient, authorizeUrl: string): Promise<ApiClient> => {
  const result = await callbackAdminLogin(stack, client, authorizeUrl);
  if (result.status !== 302) throw new Error(`GET /auth/callback answered ${result.status}: ${result.text}`);
  if (!client.cookies.has(ADMIN_COOKIE)) throw new Error("callback set no admin session cookie");
  return client;
};

/** The full login flow: start, authorize, callback. Returns the signed-in admin client. */
export const adminLogin = async (stack: Stack): Promise<ApiClient> => {
  const { client, authorizeUrl } = await startAdminLogin(stack);
  return finishAdminLogin(stack, client, authorizeUrl);
};

export interface SeedAdminSessionOptions {
  authSub?: string;
  authSid?: string;
  username?: string;
  role?: string;
  refreshToken?: string | null;
  /** Seconds until the next re-check; default 600 (the access token's lifetime). */
  recheckInSec?: number;
  /** Seconds until the session expires; default 12 h. */
  expiresInSec?: number;
  verifiedAt?: Date;
}

/**
 * Inserts an `admin_sessions` row directly and returns a client carrying
 * its cookie. The refresh token is null unless given: a seeded session is
 * for tests that do not need the refresh path.
 */
export const seedAdminSession = async (
  stack: Stack,
  options: SeedAdminSessionOptions = {},
): Promise<{ client: ApiClient; token: string }> => {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const recheckAt = new Date(now + (options.recheckInSec ?? 600) * 1000);
  const expiresAt = new Date(now + (options.expiresInSec ?? 12 * 60 * 60) * 1000);
  const verifiedAt = options.verifiedAt ?? new Date(now);
  await stack.db.query(
    `INSERT INTO admin_sessions (token_hash, auth_sub, auth_sid, username, role, refresh_token, recheck_at, verified_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      await sha256Hex(new TextEncoder().encode(token)),
      options.authSub ?? "admin-sub-1",
      options.authSid ?? "admin-sid-1",
      options.username ?? "maintainer",
      options.role ?? "admin",
      options.refreshToken ?? null,
      recheckAt,
      verifiedAt,
      expiresAt,
    ],
  );
  const client = stack.anonymous();
  client.cookies.set(ADMIN_COOKIE, token);
  return { client, token };
};

/** Posts a security event token to POST /auth/events (raw body, not JSON). */
export const postAuthEvent = async (stack: Stack, setJwt: string): Promise<number> => {
  const result = await stack.anonymous().request("POST", "//auth/events", {
    rawBody: setJwt,
    headers: { "Content-Type": "text/plain" },
  });
  return result.status;
};
