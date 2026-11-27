/**
 * The Apple sign-in driver: mints an identity token and a code through
 * FakeApple, posts them to POST /api/auth/apple, and returns a client
 * carrying the farm session token as a bearer token.
 */
import { randomBytes } from "node:crypto";
import { APP_BUNDLE_ID } from "./config";
import type { ApiClient } from "./client";
import type { Stack } from "./stack";
import { sha256Hex } from "./tkp1";

export { sha256Hex };

/** A fresh Apple `sub`, shaped like the real ones. */
export const randomSub = (): string =>
  `001234.${randomBytes(16).toString("hex")}.${randomBytes(2).toString("hex")}`;

/** Distinct loopback-adjacent addresses for X-Forwarded-For isolation (one per call). */
let addressSeq = 0;
export const nextAddress = (): string => {
  addressSeq += 1;
  return `10.201.${Math.floor(addressSeq / 250)}.${(addressSeq % 250) + 1}`;
};

/** A fresh 43-char base64url source key (32 random bytes). */
export const sourceKey = (): string => randomBytes(32).toString("base64url");

/** A deterministic 64-hex video id for a label. */
export const videoId = async (label: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(`conformance:${label}`));

export interface SignedIn {
  client: ApiClient;
  userId: string;
  sessionToken: string;
}

/**
 * Signs in as `sub` (a fresh one by default) through the real Apple flow
 * and returns a bearer-token client. Throws unless the server answers 200
 * with `{session_token, expires_at}`.
 */
export const signIn = async (
  stack: Stack,
  sub: string = randomSub(),
  options: { forwardedFor?: string } = {},
): Promise<SignedIn> => {
  const rawNonce = randomBytes(32).toString("base64url");
  const identityToken = await stack.upstream.apple.identityToken({
    sub,
    claims: { nonce: await sha256Hex(new TextEncoder().encode(rawNonce)) },
  });
  const code = stack.upstream.apple.issueCode(sub);
  const client = stack.anonymous();
  const result = await client.post<{ session_token: string; expires_at: string }>(
    "/auth/apple",
    {
      identity_token: identityToken,
      authorization_code: code,
      nonce: rawNonce,
    },
    // Sign-in is per-IP rate limited (10/min); each sign-in gets its own
    // address unless the test is probing the bucket itself.
    { headers: { "X-Forwarded-For": options.forwardedFor ?? nextAddress() } },
  );
  if (result.status !== 200) {
    throw new Error(`sign-in as ${sub} failed: ${result.status} ${result.text}`);
  }
  const sessionToken = result.body.session_token;
  if (typeof sessionToken !== "string" || sessionToken.length !== 43) {
    throw new Error(`sign-in as ${sub} returned a malformed session token: ${result.text}`);
  }
  return { client: client.withBearer(sessionToken), userId: sub, sessionToken };
};

/** Posts POST /api/consent for a client (a valid US storefront, unless the test is about the region gate). */
export const consented = async (
  client: ApiClient,
  { disclosureVersion = 3, storefrontCountry = "USA" }: { disclosureVersion?: number; storefrontCountry?: string } = {},
): Promise<void> => {
  const result = await client.post("/consent", {
    disclosure_version: disclosureVersion,
    age_confirmed: true,
    storefront_country: storefrontCountry,
  });
  if (result.status !== 204) {
    throw new Error(`consent failed: ${result.status} ${result.text}`);
  }
};

/** The bundle id the fake Apple mints tokens for. */
export const audience = APP_BUNDLE_ID;
