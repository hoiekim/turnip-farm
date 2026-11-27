/**
 * A fake OIDC auth service for the admin sign-in, adapted from budget's
 * FakeIssuer: discovery, an Ed25519 key set, and token / revocation /
 * end-session endpoints whose answers a test replaces through `state`.
 * Tokens name the `https` issuer; the server reaches this fake over plain
 * HTTP through `AUTH_BACKCHANNEL_URL`, and the test drives the authorize
 * step through the same fake's local listener.
 *
 * A test that needs an answer `state` cannot express (another status for
 * discovery or the key set, a slow endpoint) registers its own handler on
 * `stack.upstream.hub` for the issuer host: the newest handler is asked first.
 */
import { createHash, generateKeyPairSync, sign as edSign, timingSafeEqual, type KeyObject } from "node:crypto";
import { ADMIN_CLIENT_ID, ADMIN_CLIENT_SECRET, ADMIN_ISSUER } from "../config";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const AUTH_ISSUER = ADMIN_ISSUER;
export const AUTH_HOST = "auth";
export const AUTH_PUBLIC_HOST = new URL(AUTH_ISSUER).host;

const nowS = () => Math.floor(Date.now() / 1000);

type Handler = (form: URLSearchParams, request: UpstreamRequest) => Response | Promise<Response>;

interface CodeEntry {
  sub: string;
  sid: string;
  username: string;
  name: string;
  state: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  used: boolean;
}

export class FakeAuth {
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private server: ReturnType<typeof Bun.serve>;
  private unreachable = false;
  private readonly codes = new Map<string, CodeEntry>();
  private readonly refreshTokens = new Map<string, { sub: string; sid: string; username: string; name: string }>();
  private codeSeq = 0;
  private refreshSeq = 0;
  readonly port: number;
  /** Refresh tokens the farm asked to revoke, oldest first. */
  readonly revoked: string[] = [];
  state!: {
    /** The role the next tokens carry. */
    role: string;
    /** The `amr` the next ID token carries. */
    amr: string[];
    /** Seconds to age `auth_time` by (stale sign-in tests). */
    authTimeAgeSec: number;
    token: Handler;
    revoke: Handler;
    down: boolean;
    discovery: Record<string, unknown>;
  };

  constructor(private readonly hub: UpstreamHub) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };
    this.reset();
    hub.on(AUTH_HOST, (request) => this.handle(request));
    hub.on(AUTH_PUBLIC_HOST, (request) => this.handle(request));
    this.server = this.listen(0);
    this.port = this.server.port!;
  }

  private listen(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => this.hub.answer(request, AUTH_HOST) });
  }

  get backChannelUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The environment that turns admin sign-in on against this fake. */
  env(redirectUri: string, overrides: Record<string, string> = {}): Record<string, string> {
    return {
      AUTH_ISSUER,
      AUTH_CLIENT_ID: ADMIN_CLIENT_ID,
      AUTH_CLIENT_SECRET: ADMIN_CLIENT_SECRET,
      AUTH_REDIRECT_URI: redirectUri,
      AUTH_BACKCHANNEL_URL: this.backChannelUrl,
      ...overrides,
    };
  }

  private defaultDiscovery(): Record<string, unknown> {
    const at = (p: string) => `${AUTH_ISSUER}${p}`;
    return {
      issuer: AUTH_ISSUER,
      authorization_endpoint: at("/oauth/authorize"),
      token_endpoint: at("/oauth/token"),
      jwks_uri: at("/jwks"),
      revocation_endpoint: at("/oauth/revoke"),
      end_session_endpoint: at("/logout"),
    };
  }

  /** Puts every answer back to its default. The request log lives on the hub. */
  reset(): void {
    this.state = {
      role: "admin",
      amr: ["mfa"],
      authTimeAgeSec: 0,
      token: (form, request) => this.defaultToken(form, request),
      revoke: (form) => {
        this.revoked.push(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      },
      down: false,
      discovery: this.defaultDiscovery(),
    };
    this.codes.clear();
    this.refreshTokens.clear();
    this.revoked.length = 0;
  }

  private handle(request: UpstreamRequest): Response | Promise<Response> {
    if (this.state.down) return new Response(null, { status: 503 });
    switch (request.path) {
      case "/.well-known/openid-configuration":
        return jsonResponse(200, this.state.discovery);
      case "/jwks":
        return jsonResponse(200, { keys: [this.jwk] });
      case "/oauth/authorize":
        return this.authorize(request);
      case "/oauth/token":
        return this.state.token(request.form, request);
      case "/oauth/revoke":
        return this.state.revoke(request.form, request);
      case "/logout":
        return new Response(null, { status: 200 });
    }
    return jsonResponse(404, { error: "not_found" });
  }

  private authorize(request: UpstreamRequest): Response {
    const q = request.query;
    const code = `auth-code-${++this.codeSeq}`;
    this.codes.set(code, {
      sub: "admin-sub-1",
      sid: `admin-sid-${this.codeSeq}`,
      username: "maintainer",
      name: "Maintainer",
      state: q.state ?? "",
      nonce: q.nonce ?? "",
      challenge: q.code_challenge ?? "",
      redirectUri: q.redirect_uri ?? "",
      used: false,
    });
    const redirect = new URL(q.redirect_uri ?? "/auth/callback");
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", q.state ?? "");
    return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
  }

  private checkBasic(request: UpstreamRequest): boolean {
    const auth = request.headers["authorization"] ?? "";
    const expected = `Basic ${Buffer.from(`${ADMIN_CLIENT_ID}:${ADMIN_CLIENT_SECRET}`).toString("base64")}`;
    return auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  }

  private async defaultToken(form: URLSearchParams, request: UpstreamRequest): Promise<Response> {
    if (!this.checkBasic(request)) return jsonResponse(401, { error: "invalid_client" });
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const entry = this.codes.get(code);
      if (!entry || entry.used) return jsonResponse(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== entry.challenge) return jsonResponse(400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== entry.redirectUri) return jsonResponse(400, { error: "invalid_grant" });
      entry.used = true;
      return jsonResponse(200, this.tokenSet(entry));
    }
    if (grant === "refresh_token") {
      const held = this.refreshTokens.get(form.get("refresh_token") ?? "");
      if (!held) return jsonResponse(400, { error: "invalid_grant" });
      // The refresh grant carries the role auth holds now.
      return jsonResponse(200, this.tokenSet({ ...held, role: this.state.role }));
    }
    return jsonResponse(400, { error: "unsupported_grant_type" });
  }

  private tokenSet(entry: { sub: string; sid: string; username: string; name: string; nonce?: string; role?: string }): Record<string, unknown> {
    const role = entry.role ?? this.state.role;
    const refreshToken = `fake-refresh-${++this.refreshSeq}`;
    this.refreshTokens.set(refreshToken, { sub: entry.sub, sid: entry.sid, username: entry.username, name: entry.name });
    const accessToken = this.jwt(
      { alg: "EdDSA", typ: "at+jwt", kid: "k1" },
      {
        iss: AUTH_ISSUER,
        sub: entry.sub,
        aud: ADMIN_CLIENT_ID,
        iat: nowS(),
        exp: nowS() + 600,
        sid: entry.sid,
        username: entry.username,
        name: entry.name,
        role,
      },
    );
    const idToken = this.jwt(
      { alg: "EdDSA", typ: "jwt", kid: "k1" },
      {
        iss: AUTH_ISSUER,
        sub: entry.sub,
        aud: ADMIN_CLIENT_ID,
        iat: nowS(),
        exp: nowS() + 600,
        nonce: entry.nonce ?? "",
        auth_time: nowS() - this.state.authTimeAgeSec,
        amr: this.state.amr,
      },
    );
    return { access_token: accessToken, id_token: idToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 600 };
  }

  /** Stops accepting connections, the way an unreachable provider looks; `false` brings it back. */
  setUnreachable(unreachable: boolean): void {
    if (unreachable === this.unreachable) return;
    this.unreachable = unreachable;
    if (unreachable) this.server.stop(true);
    else this.server = this.listen(this.port);
  }

  /** The requests for `path`, over the back channel or at the issuer's own host. */
  seen(path: string): UpstreamRequest[] {
    return this.hub.requests.filter(
      (request) => (request.host === AUTH_HOST || request.host === AUTH_PUBLIC_HOST) && request.path === path,
    );
  }

  jwt(header: object, payload: object, key: KeyObject = this.privateKey): string {
    const h = Buffer.from(JSON.stringify(header)).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
  }

  /** A security event token carrying `events`, e.g. `{ "session.ended": { sid: "…" } }`. */
  event(type: string, fields: Record<string, string | null>): string {
    return this.jwt(
      { alg: "EdDSA", typ: "secevent+jwt", kid: "k1" },
      { iss: AUTH_ISSUER, aud: ADMIN_CLIENT_ID, iat: nowS(), jti: `evt_${crypto.randomUUID()}`, events: { [type]: fields } },
    );
  }

  /** A token signed by a key the provider never published. */
  foreignKeyToken(payload: object, header: object): string {
    return this.jwt(header, payload, generateKeyPairSync("ed25519").privateKey);
  }

  stop(): void {
    this.server.stop(true);
  }
}
