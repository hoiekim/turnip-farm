/**
 * A fake Sign in with Apple, served through the hub's CONNECT proxy: the
 * farm's Apple hosts are hardcoded, so interception is the only way to
 * fake them without touching production code.
 *
 * Modelled on the farm's own unit mock (src/auth/testing.ts) but over the
 * hub instead of a local server: an RS256 JWKS, a code exchange, and a
 * revocation endpoint, with the client secret verified on every call.
 */
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { APPLE_ISSUER, APPLE_KEY_ID, APPLE_TEAM_ID, APP_BUNDLE_ID } from "../config";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const APPLE_HOST = "appleid.apple.com";

const nowS = () => Math.floor(Date.now() / 1000);

type TokenEndpoint = (form: URLSearchParams, request: UpstreamRequest) => Response | Promise<Response>;

export interface IdentityTokenOptions {
  sub?: string;
  kid?: string;
  key?: CryptoKey | Uint8Array;
  claims?: Record<string, unknown>;
}

export class FakeApple {
  private keys: { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; jwk: Record<string, unknown> }[] = [];
  private readonly codes = new Map<string, { sub: string; used: boolean }>();
  private readonly refreshBySub = new Map<string, string>();
  private codeSeq = 0;
  private readonly farmPublicKey: CryptoKey;
  /** Every form posted to the token endpoint, oldest first. */
  readonly tokenRequests: URLSearchParams[] = [];
  /** Every form posted to the revoke endpoint, oldest first. */
  readonly revokeRequests: URLSearchParams[] = [];
  state!: { token: TokenEndpoint; revoke: TokenEndpoint };

  private constructor(
    private readonly hub: UpstreamHub,
    farmPublicKey: CryptoKey,
  ) {
    this.farmPublicKey = farmPublicKey;
    this.reset();
    hub.on(APPLE_HOST, (request) => this.handle(request));
  }

  static async create(hub: UpstreamHub, farmPublicKey: CryptoKey): Promise<FakeApple> {
    const fake = new FakeApple(hub, farmPublicKey);
    await fake.addKey("k1");
    return fake;
  }

  /** Adds another RS256 key to the JWKS (key rotation tests). */
  async addKey(kid: string): Promise<void> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    this.keys.push({ kid, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk });
  }

  private key(kid: string) {
    const found = this.keys.find((k) => k.kid === kid);
    if (!found) throw new Error(`no fake Apple key ${kid}`);
    return found;
  }

  /** Puts every answer back to its default. The request log lives on the hub. */
  reset(): void {
    this.state = {
      token: (form) => this.defaultToken(form),
      revoke: () => new Response(null, { status: 200 }),
    };
    this.codes.clear();
    this.tokenRequests.length = 0;
    this.revokeRequests.length = 0;
  }

  private handle(request: UpstreamRequest): Response | Promise<Response> {
    if (request.path === "/auth/keys" && request.method === "GET") {
      return jsonResponse(200, { keys: this.keys.map((k) => k.jwk) });
    }
    if (request.path === "/auth/token" && request.method === "POST") {
      this.tokenRequests.push(request.form);
      return this.state.token(request.form, request);
    }
    if (request.path === "/auth/revoke" && request.method === "POST") {
      this.revokeRequests.push(request.form);
      return this.state.revoke(request.form, request);
    }
    return jsonResponse(404, { error: "not_found" });
  }

  /** Verifies the farm's ES256 client secret the way Apple would. */
  private async verifyClientSecret(secret: string): Promise<boolean> {
    try {
      const { payload, protectedHeader } = await jwtVerify(secret, this.farmPublicKey, {
        issuer: APPLE_TEAM_ID,
        audience: APPLE_ISSUER,
        algorithms: ["ES256"],
      });
      if (protectedHeader.kid !== APPLE_KEY_ID) return false;
      if (payload.sub !== APP_BUNDLE_ID) return false;
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return false;
      // The farm mints a 5-minute secret (src/auth/apple.ts).
      if (payload.exp - payload.iat > 301) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async defaultToken(form: URLSearchParams): Promise<Response> {
    if (form.get("client_id") !== APP_BUNDLE_ID || form.get("grant_type") !== "authorization_code") {
      return jsonResponse(400, { error: "invalid_request" });
    }
    if (!(await this.verifyClientSecret(form.get("client_secret") ?? ""))) {
      return jsonResponse(400, { error: "invalid_client" });
    }
    const code = form.get("code") ?? "";
    const entry = this.codes.get(code);
    if (!entry || entry.used) return jsonResponse(400, { error: "invalid_grant" });
    entry.used = true;
    const sub = entry.sub;
    const refreshToken = `apple-refresh-${sub}-${++this.codeSeq}`;
    this.refreshBySub.set(sub, refreshToken);
    return jsonResponse(200, {
      access_token: `apple-access-${sub}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      id_token: await this.identityToken({ sub }),
    });
  }

  /** A single-use authorization code resolving to `sub` at the token endpoint. */
  issueCode(sub: string): string {
    const code = `code-${++this.codeSeq}-${createHash("sha256").update(sub).digest("hex").slice(0, 8)}`;
    this.codes.set(code, { sub, used: false });
    return code;
  }

  /**
   * An RS256 identity token, shaped like Apple's, including the email
   * claims the farm must never keep. `nonce` is the already-hashed value
   * the farm compares against sha256Hex(raw nonce).
   */
  async identityToken({ sub = "001234.0123456789abcdef0123456789abcdef.0123", kid = "k1", key, claims = {} }: IdentityTokenOptions = {}): Promise<string> {
    const signingKey = key ?? this.key(kid).privateKey;
    const alg = signingKey instanceof Uint8Array ? "HS256" : "RS256";
    return new SignJWT({
      iss: APPLE_ISSUER,
      aud: APP_BUNDLE_ID,
      sub,
      iat: nowS(),
      exp: nowS() + 600,
      email: "abc@privaterelay.appleid.com",
      is_private_email: true,
      ...claims,
    })
      .setProtectedHeader({ alg, kid })
      .sign(signingKey as never);
  }

  /** A notification JWT: signed like an identity token but with no `exp`, the subject inside `events`. */
  async notificationPayload({ kid = "k1", key, claims = {} }: IdentityTokenOptions = {}): Promise<string> {
    const signingKey = key ?? this.key(kid).privateKey;
    const alg = signingKey instanceof Uint8Array ? "HS256" : "RS256";
    return new SignJWT({
      iss: APPLE_ISSUER,
      aud: APP_BUNDLE_ID,
      iat: nowS(),
      jti: `mock-jti-${++this.codeSeq}`,
      ...claims,
    })
      .setProtectedHeader({ alg, kid })
      .sign(signingKey as never);
  }

  /** The refresh token most recently minted for `sub` (what a revoke call must carry). */
  refreshTokenFor(sub: string): string | undefined {
    return this.refreshBySub.get(sub);
  }

  /** The token-endpoint forms, as plain objects, for assertions. */
  tokenForms(): Record<string, string>[] {
    return this.tokenRequests.map((form) => Object.fromEntries(form));
  }

  /** The revoke-endpoint forms, as plain objects, for assertions. */
  revokeForms(): Record<string, string>[] {
    return this.revokeRequests.map((form) => Object.fromEntries(form));
  }
}
