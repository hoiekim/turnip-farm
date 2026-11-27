/**
 * One started server and everything around it: an empty database, the
 * intercepted upstreams, and clients to drive it. A test file starts one (or
 * several, when it needs different settings) and stops each when done.
 *
 *   let stack: Stack;
 *   beforeAll(async () => { stack = await startStack(); });
 *   afterAll(() => stack.stop());
 *
 * The server does not migrate its own schema, so each stack creates a
 * fresh database and runs `dbmate migrate` against it before starting.
 * The ingest poller is off by default (INGEST_POLL_INTERVAL_MS=0);
 * ingest tests pass a short interval.
 */
import {
  ADMIN_CLIENT_ID,
  APPLE_KEY_ID,
  APPLE_TEAM_ID,
  APP_BUNDLE_ID,
  CLIENT_DIR,
  POSTGRES,
  PIPELINE_KEY,
  R2_ACCESS_KEY_ID,
  R2_ACCOUNT_ID,
  R2_BUCKET,
  R2_SECRET_ACCESS_KEY,
  REFRESH_TOKEN_KEY_B64,
  REPO_ROOT,
  TARGET,
  VERBOSE,
  getFarmAppleKey,
  serverCommand,
} from "./config";
import { ApiClient } from "./client";
import { Database } from "./postgres";
import { callerTestFile, flush, record } from "./transcript";
import { UpstreamHub } from "./upstreams/hub";
import { FakeApple } from "./upstreams/apple";
import { FakeR2 } from "./upstreams/r2";
import { FakeAuth } from "./upstreams/auth";
import { serverPort } from "./ports";
import { sha256Hex } from "./tkp1";

export interface StackOptions {
  /** Extra environment for the server; `undefined` removes a default. */
  env?: Record<string, string | undefined>;
  /** Turn admin sign-in on against the fake auth service, with these `AUTH_*` overrides. */
  admin?: Record<string, string> | boolean;
  /** Run before the server starts, with the migrated database: seed rows a boot-time job should find. */
  beforeStart?: (stack: Stack) => Promise<void> | void;
  /** Ingest poll interval in ms; default 0 (poller off). */
  ingestIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fileStackCounts = new Map<string, number>();

/** Request headers worth comparing between the two servers' upstream calls. */
const UPSTREAM_HEADERS = ["authorization", "content-type", "x-amz-date", "x-amz-content-sha256"];

/**
 * The full valid farm environment for `dbName`, minus PORT and the
 * proxy/CA settings (those need a running hub; `startStack` adds them).
 * Shared by `startStack` and the boot tests.
 */
export const validFarmEnv = async (dbName: string): Promise<Record<string, string | undefined>> => {
  const appleKey = await getFarmAppleKey();
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: process.env.TZ ?? "UTC",
    DATABASE_URL: `postgres://${POSTGRES.user}:${POSTGRES.password}@${POSTGRES.host}:${POSTGRES.port}/${dbName}?sslmode=disable`,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    APP_BUNDLE_ID,
    APPLE_TEAM_ID,
    APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: appleKey.pem,
    APPLE_REFRESH_TOKEN_KEY: REFRESH_TOKEN_KEY_B64,
    TURNIP_PIPELINE_KEY: PIPELINE_KEY,
    INGEST_POLL_INTERVAL_MS: "0",
    LOG_LEVEL: "info",
  };
};

const runDbmate = async (databaseUrl: string): Promise<void> => {
  const child = Bun.spawn(
    ["node_modules/.bin/dbmate", "--wait", "--no-dump-schema", "migrate"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`dbmate migrate failed (exit ${code}):\n${out}\n${err}`);
};

export class Stack {
  readonly logs: string[] = [];
  readonly upstream: {
    hub: UpstreamHub;
    apple: FakeApple;
    r2: FakeR2;
    auth: FakeAuth;
  };
  port = 0;
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private env: Record<string, string> = {};
  private stopped = false;
  private upstreamRecorded = 0;

  private constructor(
    readonly db: Database,
    hub: UpstreamHub,
    apple: FakeApple,
    r2: FakeR2,
    auth: FakeAuth,
    private readonly file: string,
    private readonly index: number,
  ) {
    this.upstream = { hub, apple, r2, auth };
  }

  static async start(options: StackOptions = {}, file = callerTestFile()): Promise<Stack> {
    const index = fileStackCounts.get(file) ?? 0;
    fileStackCounts.set(file, index + 1);
    const [db, hub] = await Promise.all([Database.create(file.replace(/\.test\.ts$/, "")), UpstreamHub.start()]);
    const appleKey = await getFarmAppleKey();
    const apple = await FakeApple.create(hub, appleKey.publicKey);
    const r2 = new FakeR2(hub);
    const auth = new FakeAuth(hub);
    const stack = new Stack(db, hub, apple, r2, auth, file, index);
    try {
      stack.port = await serverPort();
      stack.env = await stack.buildEnv(options);
      const databaseUrl = stack.env.DATABASE_URL!;
      await runDbmate(databaseUrl);
      await options.beforeStart?.(stack);
      await stack.spawn();
    } catch (error) {
      await stack.stop();
      throw error;
    }
    return stack;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async buildEnv(options: StackOptions): Promise<Record<string, string>> {
    const env: Record<string, string | undefined> = {
      ...(await validFarmEnv(this.db.name)),
      PORT: String(this.port),
      // Outbound HTTPS goes to the fakes; the database and the auth
      // back channel are reached directly.
      HTTPS_PROXY: this.upstream.hub.proxyUrl,
      https_proxy: this.upstream.hub.proxyUrl,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: this.upstream.hub.caPath,
      SSL_CERT_FILE: this.upstream.hub.caPath,
      // Read by the Rust server only; the Bun server derives it from the bundle location.
      CLIENT_DIR,
    };
    if (options.ingestIntervalMs !== undefined) env.INGEST_POLL_INTERVAL_MS = String(options.ingestIntervalMs);
    if (options.admin) {
      Object.assign(
        env,
        this.upstream.auth.env(`http://127.0.0.1:${this.port}/auth/callback`, options.admin === true ? {} : options.admin),
      );
    }
    Object.assign(env, options.env);
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) cleaned[key] = value;
    return cleaned;
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        this.logs.push(line);
        if (VERBOSE) console.log(`[${TARGET}:${this.port}] ${line}`);
      }
    }
    if (pending) this.logs.push(pending);
  }

  private async spawn(): Promise<void> {
    const child = Bun.spawn({
      cmd: serverCommand(),
      cwd: REPO_ROOT,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    this.process = child;
    void this.pump(child.stdout as ReadableStream<Uint8Array>);
    void this.pump(child.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`the ${TARGET} server exited with ${child.exitCode} while starting:\n${this.logs.join("\n")}`);
      }
      try {
        const response = await fetch(`${this.origin}/healthz`);
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        // not listening yet
      }
      await sleep(50);
    }
    throw new Error(`the ${TARGET} server did not become healthy:\n${this.logs.join("\n")}`);
  }

  /** How many log lines so far contain `text`. */
  logCount(text: string): number {
    return this.logs.filter((line) => line.includes(text)).length;
  }

  /** Resolves once `count` log lines contain `text` (by default, once one more than now does). */
  async waitForLog(text: string, { count, timeoutMs = 30_000 }: { count?: number; timeoutMs?: number } = {}): Promise<void> {
    const target = count ?? this.logCount(text) + 1;
    const deadline = Date.now() + timeoutMs;
    while (this.logCount(text) < target) {
      if (Date.now() > deadline) {
        throw new Error(`no log line containing "${text}" (wanted ${target}) within ${timeoutMs} ms:\n${this.logs.slice(-40).join("\n")}`);
      }
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`the ${TARGET} server exited while waiting for "${text}":\n${this.logs.slice(-40).join("\n")}`);
      }
      await sleep(20);
    }
  }

  /** Polls `check` until it returns something truthy; throws after `timeoutMs`. */
  async waitFor<T>(check: () => Promise<T> | T, { timeoutMs = 15_000, what = "condition" } = {}): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  /** A client with no session. */
  anonymous(): ApiClient {
    return new ApiClient(this.origin, this.file, this.index);
  }

  /** A client carrying the pipeline key (never a user session token). */
  pipeline(): ApiClient {
    return this.anonymous().withBearer(PIPELINE_KEY);
  }

  /**
   * Stops the server and starts it again on the same database and port, the
   * way a deploy does: in-memory state (rate limits, caches) is gone,
   * stored state stays, and the boot-time retention runs again.
   */
  async restart(env: Record<string, string | undefined> = {}): Promise<void> {
    await this.kill();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete this.env[key];
      else this.env[key] = value;
    }
    await this.spawn();
  }

  private async kill(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited, sleep(5_000).then(() => "timeout" as const)]);
    if (exited === "timeout") {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  /** Copies the upstream calls made since the last call into the transcript. */
  private recordUpstream(): void {
    const { requests } = this.upstream.hub;
    for (const request of requests.slice(this.upstreamRecorded)) {
      const headers: Record<string, string> = {};
      for (const name of UPSTREAM_HEADERS) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      record(this.file, {
        kind: "upstream",
        stack: this.index,
        host: request.host,
        method: request.method,
        path: request.path,
        search: request.search,
        body: { headers, body: request.json ?? request.body },
        ...(request.unordered === undefined ? {} : { unordered: request.unordered }),
      });
    }
    this.upstreamRecorded = requests.length;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.kill();
    this.recordUpstream();
    flush(this.file);
    this.upstream.auth.stop();
    this.upstream.r2.stop();
    await this.upstream.hub.stop();
    await this.db.drop();
  }
}

export const startStack = (options: StackOptions = {}): Promise<Stack> => Stack.start(options, callerTestFile());

/** The SHA-256 hex of a session token, the way the farm stores it. */
export const sessionTokenHash = (token: string): Promise<string> => sha256Hex(new TextEncoder().encode(token));
