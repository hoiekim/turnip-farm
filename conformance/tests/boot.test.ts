import { describe, expect, test } from "bun:test";
import { startExpectingFailure } from "../harness/boot";
import { REPO_ROOT, serverCommand } from "../harness/config";
import { serverPort } from "../harness/ports";
import { validFarmEnv } from "../harness/stack";

// The 11 required variables, as listed in src/config.ts REQUIRED_ENV.
// Hardcoded here on purpose: the test pins the contract, it does not read
// it back from the implementation.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "APP_BUNDLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_REFRESH_TOKEN_KEY",
  "TURNIP_PIPELINE_KEY",
] as const;

describe("boot", () => {
  const invalid = async (env: Record<string, string | undefined>) => {
    const result = await startExpectingFailure(env);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid configuration:");
    return result.output;
  };

  test("each required variable missing is named", async () => {
    for (const name of REQUIRED_ENV) {
      const output = await invalid({ [name]: undefined });
      expect(output).toContain(`  - ${name} is required`);
    }
  });

  test("several missing variables are all listed in one message", async () => {
    const output = await invalid({ DATABASE_URL: undefined, R2_BUCKET: undefined, APPLE_TEAM_ID: "" });
    expect(output).toContain("  - DATABASE_URL is required");
    expect(output).toContain("  - R2_BUCKET is required");
    expect(output).toContain("  - APPLE_TEAM_ID is required");
  });

  test("PORT must be an integer from 1 to 65535", async () => {
    for (const port of ["0", "65536", "abc", "3000.5"]) {
      const output = await invalid({ PORT: port });
      expect(output).toContain(`  - PORT must be an integer between 1 and 65535 (got "${port}")`);
    }
  });

  test("APPLE_PRIVATE_KEY must be a PKCS#8 PEM, and then a valid ES256 key", async () => {
    const shape = await invalid({ APPLE_PRIVATE_KEY: "not a pem" });
    expect(shape).toContain("  - APPLE_PRIVATE_KEY must be the PKCS#8 PEM contents of the .p8 key");
    const garbagePem = `-----BEGIN PRIVATE KEY-----\n${Buffer.alloc(32).toString("base64")}\n-----END PRIVATE KEY-----`;
    const importable = await invalid({ APPLE_PRIVATE_KEY: garbagePem });
    expect(importable).toContain("  - APPLE_PRIVATE_KEY is not a valid ES256 PKCS#8 key");
  });

  test("APPLE_REFRESH_TOKEN_KEY must be 32 bytes, base64-encoded", async () => {
    for (const key of ["AAAA", "not-base64!!", Buffer.alloc(16).toString("base64")]) {
      const output = await invalid({ APPLE_REFRESH_TOKEN_KEY: key });
      expect(output).toContain("  - APPLE_REFRESH_TOKEN_KEY must be 32 random bytes, base64-encoded");
    }
  });

  test("a partial AUTH_* set names the missing variables", async () => {
    const output = await invalid({ AUTH_ISSUER: "https://auth.example.test" });
    expect(output).toContain(
      "  - AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_REDIRECT_URI must be set with the other AUTH_* variables, or none of them",
    );
  });

  test("AUTH_ISSUER must be an https URL; AUTH_REDIRECT_URI must end in /auth/callback", async () => {
    const badIssuer = await invalid({
      AUTH_ISSUER: "not-a-url",
      AUTH_CLIENT_ID: "turnip-farm",
      AUTH_CLIENT_SECRET: "conformance-admin-secret",
      AUTH_REDIRECT_URI: "https://auth.example.test/auth/callback",
    });
    expect(badIssuer).toContain("  - AUTH_ISSUER must be an https URL (http only for localhost)");
    const badRedirect = await invalid({
      AUTH_ISSUER: "https://auth.example.test",
      AUTH_CLIENT_ID: "turnip-farm",
      AUTH_CLIENT_SECRET: "conformance-admin-secret",
      AUTH_REDIRECT_URI: "https://auth.example.test/login",
    });
    expect(badRedirect).toContain("  - AUTH_REDIRECT_URI must be this farm's https URL ending in /auth/callback");
  });

  test("CURRENT_DISCLOSURE_VERSION must be a positive integer within range", async () => {
    for (const version of ["0", "-1", "abc", "2147483648"]) {
      const output = await invalid({ CURRENT_DISCLOSURE_VERSION: version });
      expect(output).toContain(`  - CURRENT_DISCLOSURE_VERSION must be a positive integer (got "${version}")`);
    }
  });

  test("TRUSTED_PROXIES entries must be IPs or CIDR ranges", async () => {
    const output = await invalid({ TRUSTED_PROXIES: "10.0.0.0/8, not-an-ip" });
    expect(output).toContain('  - TRUSTED_PROXIES entry "not-an-ip" is not an IP address or CIDR range');
  });

  /**
   * Spawns the real server with the given env overrides; the caller owns
   * the child and must stop it. The database named does not exist, so a
   * server that wrongly gets past its settings cannot touch anything —
   * and the server starts anyway: the startup retention only logs a
   * database it cannot reach.
   */
  const spawnServer = async (env: Record<string, string | undefined>) => {
    const port = await serverPort();
    const full: Record<string, string | undefined> = {
      ...(await validFarmEnv("conformance_never_created")),
      PORT: String(port),
      ...env,
    };
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(full)) if (value !== undefined) cleaned[key] = value;
    const child = Bun.spawn({
      cmd: serverCommand(),
      cwd: REPO_ROOT,
      env: cleaned,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
      ([out, err]) => out + err,
    );
    return { child, port, output };
  };

  const waitHealthy = async (port: number) => {
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (up) return;
      await Bun.sleep(50);
    }
    throw new Error(`server on ${port} never became healthy`);
  };

  test("SIGTERM shuts down cleanly: exit 0 and the shutting-down line", async () => {
    const { child, port, output } = await spawnServer({});
    try {
      await waitHealthy(port);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(child.signalCode).toBeNull();
      expect(await output).toContain("turnip-farm shutting down");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("an unreachable database still starts and answers /healthz", async () => {
    const { child, port, output } = await spawnServer({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/conformance_never_created?sslmode=disable",
    });
    try {
      await waitHealthy(port);
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      // The startup retention only logs the unreachable database; the
      // server listened anyway, and still shut down cleanly.
      expect(await output).toContain("turnip-farm listening on");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
