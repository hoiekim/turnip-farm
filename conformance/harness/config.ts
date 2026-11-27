/**
 * Where a conformance run points: which server it starts, and the Postgres
 * instance it makes its databases in. Everything is read from the
 * environment, so the same test files run against either server.
 */
import path from "node:path";

export type Target = "bun" | "rust";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const targetOf = (raw: string | undefined): Target => {
  if (raw === undefined || raw === "" || raw === "bun") return "bun";
  if (raw === "rust") return "rust";
  throw new Error(`CONFORMANCE_TARGET must be "bun" or "rust", not "${raw}"`);
};

export const TARGET: Target = targetOf(process.env.CONFORMANCE_TARGET);

/** The command that starts the server under test, run from the repository root. */
export const serverCommand = (): string[] => {
  if (TARGET === "bun") return ["bun", "--no-env-file", path.join(REPO_ROOT, "build", "server", "bundle.js")];
  const explicit = process.env.CONFORMANCE_RUST_BIN;
  return [explicit ? path.resolve(REPO_ROOT, explicit) : path.join(REPO_ROOT, "target", "debug", "turnip-farm-server")];
};

/** The directory the Rust server serves the client from; the Bun server derives it from the bundle location. */
export const CLIENT_DIR = path.join(REPO_ROOT, "build", "client");

export const POSTGRES = {
  host: process.env.CONFORMANCE_PG_HOST || "127.0.0.1",
  port: Number(process.env.CONFORMANCE_PG_PORT || 5432),
  user: process.env.CONFORMANCE_PG_USER || "postgres",
  password: process.env.CONFORMANCE_PG_PASSWORD || "postgres",
};

/** Echo the server's output while tests run. */
export const VERBOSE = process.env.CONFORMANCE_VERBOSE === "1";

/** Where request/response transcripts are written, one file per test file and target. */
export const TRANSCRIPT_DIR = process.env.CONFORMANCE_TRANSCRIPT_DIR
  ? path.resolve(process.env.CONFORMANCE_TRANSCRIPT_DIR)
  : path.join(REPO_ROOT, "conformance", ".transcripts");

/** Fixed test constants for the fake upstreams (see conformance/README.md). */
export const APP_BUNDLE_ID = "kim.hoie.turnip.conformance";
export const APPLE_TEAM_ID = "TEAM123456";
export const APPLE_KEY_ID = "KEY1234567";
export const APPLE_ISSUER = "https://appleid.apple.com";
export const R2_ACCOUNT_ID = "conformance-account";
export const R2_BUCKET = "turnip-conformance";
export const R2_ACCESS_KEY_ID = "conformance-access";
export const R2_SECRET_ACCESS_KEY = "conformance-secret";
export const PIPELINE_KEY = "conformance-pipeline-key";
export const ADMIN_ISSUER = "https://auth.example.test";
export const ADMIN_CLIENT_ID = "turnip-farm";
export const ADMIN_CLIENT_SECRET = "conformance-admin-secret";

/** Fixed APPLE_REFRESH_TOKEN_KEY: 32 bytes of 0x07, base64. Never the zero key the unit tests use. */
export const REFRESH_TOKEN_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

/** The R2 hosts the fake answers for, derived from the test R2 config above. */
export const R2_VIRTUAL_HOST = `${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
export const R2_PATH_HOST = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

/**
 * A fresh ES256 (P-256) keypair per run for APPLE_PRIVATE_KEY, generated the
 * same way src/index.test.ts does. The harness keeps the public key so
 * FakeApple can verify the farm's client-secret JWTs.
 */
export interface FarmAppleKey {
  pem: string;
  publicKey: CryptoKey;
}

let farmAppleKey: Promise<FarmAppleKey> | undefined;

export const getFarmAppleKey = (): Promise<FarmAppleKey> =>
  (farmAppleKey ??= (async () => {
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64");
    return {
      pem: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
      publicKey: key.publicKey,
    };
  })());
