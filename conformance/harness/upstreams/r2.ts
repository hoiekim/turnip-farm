/**
 * A fake R2, served two ways over one shared in-memory store:
 *
 * - On the hub (CONNECT proxy), at both R2 hosts: the virtual-host style
 *   the presigned URLs use (`<bucket>.<account>.r2.cloudflarestorage.com`)
 *   and the path style the ingest store's header-signed requests use
 *   (`<account>.r2.cloudflarestorage.com/<bucket>/<key>`).
 * - On plain HTTP on 127.0.0.1:0, for test-side uploads and downloads:
 *   the test rewrites a presigned URL's origin to this endpoint (the test
 *   process deliberately runs with no proxy, so it cannot reach the hub's
 *   TLS server). The fake does not verify the presigned query signature
 *   on the test PUT — the signature is asserted structurally in the
 *   `POST /api/sources` response test — but it stores the checksum
 *   header, so the ingest checksum re-verification runs.
 *
 * SigV4 is verified on the server-side paths (header signature on store
 * requests, query signature on presigned GET/DELETE), recomputing the
 * canonical request per src/r2/presign.ts and src/ingest/store.ts with
 * the known test credentials; a mismatch answers 403. That pins the Rust
 * port's signing, which no HTTP assertion would otherwise cover.
 */
import { createHash, createHmac } from "node:crypto";
import { R2_ACCESS_KEY_ID, R2_BUCKET, R2_ACCOUNT_ID, R2_PATH_HOST, R2_SECRET_ACCESS_KEY, R2_VIRTUAL_HOST } from "../config";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export interface StoredObject {
  body: Buffer;
  /** Base64 SHA-256 the object was stored with, when it carries one. */
  checksumSha256: string | null;
  contentType: string;
}

const REGION = "auto";
const SERVICE = "s3";

const hmacSha256 = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

const signingKey = (dateStamp: string): Buffer => {
  const kDate = hmacSha256(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmacSha256(kDate, REGION);
  const kService = hmacSha256(kRegion, SERVICE);
  return hmacSha256(kService, "aws4_request");
};

/** Verifies a presigned query signature (presign.ts canonical form). */
const verifyPresigned = (request: UpstreamRequest, key: string): boolean => {
  const params = new URLSearchParams(request.search);
  const signature = params.get("X-Amz-Signature");
  const amzDate = params.get("X-Amz-Date") ?? "";
  const credential = params.get("X-Amz-Credential") ?? "";
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  if (credential !== `${R2_ACCESS_KEY_ID}/${scope}`) return false;
  if (params.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return false;
  if (params.get("X-Amz-SignedHeaders") !== "host") return false;
  const signed = [...params.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = [
    request.method,
    `/${key.split("/").map(encodeURIComponent).join("/")}`,
    signed,
    `host:${request.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  return hmacSha256(signingKey(dateStamp), stringToSign).toString("hex") === signature;
};

/** Verifies a header-signed request (ingest/store.ts canonical form). */
const verifyHeaderSigned = (request: UpstreamRequest, path: string): boolean => {
  const auth = request.headers["authorization"] ?? "";
  const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
  if (!match) return false;
  const [, credential, signedHeaders, signature] = match;
  const amzDate = request.headers["x-amz-date"] ?? "";
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  if (credential !== `${R2_ACCESS_KEY_ID}/${scope}`) return false;
  const names = signedHeaders!.split(";");
  const canonicalHeaders = names.map((n) => `${n}:${(request.headers[n] ?? "").trim()}\n`).join("");
  const payloadHash = request.headers["x-amz-content-sha256"] ?? "";
  const canonicalRequest = [
    request.method,
    path,
    request.search,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  return hmacSha256(signingKey(dateStamp), stringToSign).toString("hex") === signature;
};

export type R2Operation = "GET" | "PUT" | "DELETE" | "LIST";

export class FakeR2 {
  private readonly store = new Map<string, StoredObject>();
  private readonly lies = new Map<string, number>();
  private readonly failNextMap = new Map<R2Operation, number>();
  private readonly gateMap = new Map<string, () => Promise<void>>();
  private server: ReturnType<typeof Bun.serve>;
  readonly port: number;

  constructor(private readonly hub: UpstreamHub) {
    hub.on(R2_VIRTUAL_HOST, (request) => this.handleVirtual(request));
    hub.on(R2_PATH_HOST, (request) => this.handlePath(request));
    // Plain-HTTP endpoint for test-side uploads/downloads, same store.
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.handleLocal(request),
    });
    this.port = this.server.port!;
  }

  /** The origin a test rewrites presigned URLs to. */
  get localOrigin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Rewrites a presigned URL's origin to the local endpoint, keeping path + query. */
  localUrl(url: string): string {
    const parsed = new URL(url);
    parsed.protocol = "http:";
    parsed.host = `127.0.0.1:${this.port}`;
    return parsed.toString();
  }

  /** The object at `key`, or undefined. Tests assert blob bytes through this, not the transcript. */
  get(key: string): StoredObject | undefined {
    return this.store.get(key);
  }

  /** Every key in the store, sorted. */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  put(key: string, body: Buffer, checksumSha256: string | null = null, contentType = "application/octet-stream"): void {
    this.store.set(key, { body, checksumSha256, contentType });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Answer the next `operation` on either R2 host with `status` (one-shot). */
  failNext(operation: R2Operation, status: number): void {
    this.failNextMap.set(operation, status);
  }

  private takeFail(operation: R2Operation): number | undefined {
    const status = this.failNextMap.get(operation);
    if (status !== undefined) this.failNextMap.delete(operation);
    return status;
  }

  /**
   * Make the fake answer a GET for `key` with `declaredBytes` of zero bytes
   * instead of the stored body (the BLOB_TOO_LARGE trick): the farm counts
   * the bytes as they pass and rejects past 64 MiB without the test moving
   * a real 64 MiB blob into the store. No Content-Length is set — Bun.serve
   * rewrites it to the actual body length, so a fake cannot lie about the
   * declared length through it; the header-check branch of `cappedBody`
   * is unit-level, and this exercises the counted-bytes branch.
   */
  lieAboutLength(key: string, declaredBytes: number): void {
    this.lies.set(key, declaredBytes);
  }

  /**
   * Hold GETs for `key` until the returned release function runs (blob
   * verification slot tests). Each held GET waits on its own gate.
   */
  gateGet(key: string): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gateMap.set(key, () => gate);
    return () => {
      this.gateMap.delete(key);
      release();
    };
  }

  private listXml(prefix: string, maxKeys: number, continuation?: string): string {
    const keys = this.keys().filter((k) => k.startsWith(prefix));
    const start = continuation ? Number(continuation) : 0;
    const page = keys.slice(start, start + maxKeys);
    const truncated = start + page.length < keys.length;
    const next = truncated ? String(start + page.length) : "";
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
      `<Name>${R2_BUCKET}</Name><Prefix>${prefix}</Prefix><MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${truncated}</IsTruncated>`,
      ...page.map((k) => `<Contents><Key>${k}</Key></Contents>`),
      ...(truncated ? [`<NextContinuationToken>${next}</NextContinuationToken>`] : []),
      `</ListBucketResult>`,
    ].join("");
  }

  private getResponse(key: string): Response {
    const object = this.store.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers: Record<string, string> = { "Content-Type": object.contentType };
    if (object.checksumSha256) headers["x-amz-checksum-sha256"] = object.checksumSha256;
    const lie = this.lies.get(key);
    if (lie !== undefined) {
      // Stream `lie` zero bytes: the farm's counted-bytes cap rejects past
      // 64 MiB. Chunked, so no Content-Length is asserted (see lieAboutLength).
      const chunk = new Uint8Array(1024 * 1024);
      let remaining = lie;
      const stream = new ReadableStream({
        pull(controller) {
          if (remaining <= 0) {
            controller.close();
            return;
          }
          const n = Math.min(chunk.byteLength, remaining);
          controller.enqueue(chunk.subarray(0, n));
          remaining -= n;
        },
      });
      return new Response(stream, { status: 200, headers });
    }
    return new Response(object.body as unknown as Uint8Array<ArrayBuffer>, { status: 200, headers });
  }

  private async handleVirtual(request: UpstreamRequest): Promise<Response> {
    const key = decodeURIComponent(request.path.slice(1));
    const operation = request.method as R2Operation;
    const fail = this.takeFail(operation);
    if (fail !== undefined) return new Response(null, { status: fail });
    if (request.method === "GET") {
      if (!verifyPresigned(request, key)) return jsonResponse(403, { error: "SignatureDoesNotMatch" });
      const gate = this.gateMap.get(key);
      if (gate) await gate();
      return this.getResponse(key);
    }
    if (request.method === "DELETE") {
      if (!verifyPresigned(request, key)) return jsonResponse(403, { error: "SignatureDoesNotMatch" });
      this.store.delete(key);
      return new Response(null, { status: 200 });
    }
    return jsonResponse(404, { error: "not_found" });
  }

  private async handlePath(request: UpstreamRequest): Promise<Response> {
    const url = new URL(`https://x${request.path}${request.search ? `?${request.search}` : ""}`);
    const operation = request.method as R2Operation;
    // LIST: GET /<bucket>?list-type=2&prefix=...&max-keys=...
    if (request.method === "GET" && url.pathname === `/${R2_BUCKET}` && url.searchParams.get("list-type") === "2") {
      const fail = this.takeFail("LIST");
      if (fail !== undefined) return new Response(null, { status: fail });
      if (!verifyHeaderSigned(request, url.pathname)) return jsonResponse(403, { error: "SignatureDoesNotMatch" });
      return new Response(this.listXml(
        url.searchParams.get("prefix") ?? "",
        Number(url.searchParams.get("max-keys") ?? 1000),
        url.searchParams.get("continuation-token") ?? undefined,
      ), { headers: { "Content-Type": "application/xml" } });
    }
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${R2_BUCKET}/`), ""));
    if (!url.pathname.startsWith(`/${R2_BUCKET}/`)) return jsonResponse(404, { error: "not_found" });
    const fail = this.takeFail(operation);
    if (fail !== undefined) return new Response(null, { status: fail });
    if (!verifyHeaderSigned(request, url.pathname)) return jsonResponse(403, { error: "SignatureDoesNotMatch" });
    if (request.method === "GET") {
      const gate = this.gateMap.get(key);
      if (gate) await gate();
      return this.getResponse(key);
    }
    if (request.method === "PUT") {
      const declared = Number(request.headers["content-length"] ?? request.bytes.length);
      if (request.bytes.length !== declared) return jsonResponse(400, { error: "IncompleteBody" });
      const checksum = request.headers["x-amz-checksum-sha256"] ?? null;
      if (checksum !== null) {
        const actual = createHash("sha256").update(request.bytes).digest("base64");
        if (actual !== checksum) return jsonResponse(400, { error: "BadDigest" });
      }
      const payloadHash = request.headers["x-amz-content-sha256"] ?? "";
      if (payloadHash !== createHash("sha256").update(request.bytes).digest("hex")) {
        return jsonResponse(400, { error: "SignatureDoesNotMatch" });
      }
      this.store.set(key, {
        body: Buffer.from(request.bytes),
        checksumSha256: checksum,
        contentType: request.headers["content-type"] ?? "application/octet-stream",
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === "DELETE") {
      this.store.delete(key);
      return new Response(null, { status: 200 });
    }
    return jsonResponse(404, { error: "not_found" });
  }

  private async handleLocal(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const checksum = request.headers.get("x-amz-checksum-sha256") ?? request.headers.get("Content-MD5") ?? null;
      this.store.set(key, {
        body: Buffer.from(bytes),
        checksumSha256: checksum,
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") return this.getResponse(key);
    if (request.method === "DELETE") {
      this.store.delete(key);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }

  stop(): void {
    this.server.stop(true);
  }
}
