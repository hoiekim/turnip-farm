import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, randomSub, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedSession, seedSource, seedStagedBlob } from "../harness/seed/contrib";
import { seedModel } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";
import type { ApiClient } from "../harness/client";

describe("sources", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  /** A consented client for a fresh user. */
  const setup = async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client);
    return { client, userId };
  };

  const registerBody = async (overrides: Record<string, unknown> = {}) => ({
    video_id: await videoId(`sources-${Math.random()}`),
    source_key: sourceKey(),
    frame_count: 100,
    sample_rate: 10,
    keypoint_format: "tkp1",
    storefront_country: "USA",
    ...overrides,
  });

  const register = (client: ApiClient, overrides: Record<string, unknown> = {}) =>
    registerBody(overrides).then((body) => client.post("/sources", body).then((r) => ({ result: r, body })));

  test("region gates: missing is 403 before auth, blocked is 403, malformed is 422 after auth", async () => {
    const missing = await stack.anonymous().post("/sources", {
      video_id: await videoId("region-missing"),
      source_key: sourceKey(),
      frame_count: 100,
      sample_rate: 10,
      keypoint_format: "tkp1",
    });
    expect(missing.status).toBe(403);
    expect(missing.json).toEqual({
      error: { code: "REGION_UNAVAILABLE", message: "Contribution is not available in this region", details: { reason: "storefront_missing" } },
    });
    const blocked = await stack.anonymous().post("/sources", {
      video_id: await videoId("region-blocked"),
      source_key: sourceKey(),
      frame_count: 100,
      sample_rate: 10,
      keypoint_format: "tkp1",
      storefront_country: "DEU",
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({
      error: { code: "REGION_UNAVAILABLE", message: "Contribution is not available in this region", details: { reason: "storefront_blocked" } },
    });
    const { client } = await setup();
    const malformed = await client.post("/sources", {
      video_id: await videoId("region-malformed"),
      source_key: sourceKey(),
      frame_count: 100,
      sample_rate: 10,
      keypoint_format: "tkp1",
      storefront_country: "US",
    });
    expect(malformed.status).toBe(422);
    expect(malformed.json).toEqual({
      error: { code: "VALIDATION_ERROR", message: "storefront_country must be an ISO 3166-1 alpha-3 code", details: { field: "storefront_country" } },
    });
  });

  test("401 anonymous, 403 blocked, 403 without consent", async () => {
    const anon = await stack.anonymous().post("/sources", await registerBody());
    expect(anon.status).toBe(401);
    const blockedSub = randomSub();
    const { client: blockedClient } = await seedSession(stack, blockedSub, { isBlocked: true });
    const blocked = await blockedClient.post("/sources", await registerBody());
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({ error: { code: "ACCOUNT_BLOCKED", message: "Account blocked", details: {} } });
    const { client } = await seedSession(stack, randomSub());
    const unconsented = await client.post("/sources", await registerBody());
    expect(unconsented.status).toBe(403);
    expect(unconsented.json).toEqual({
      error: { code: "CONSENT_REQUIRED", message: "Agree to the current contribution disclosure first", details: { disclosure_version: 3 } },
    });
  });

  test("validation matrix: video_id, source_key, frame_count, sample_rate, keypoint_format", async () => {
    const { client } = await setup();
    const cases: { name: string; overrides: Record<string, unknown>; code: string; message: string }[] = [
      { name: "short video_id", overrides: { video_id: "abc" }, code: "VALIDATION_ERROR", message: "video_id must be 64-char lowercase hex" },
      { name: "uppercase video_id", overrides: { video_id: "A".repeat(64) }, code: "VALIDATION_ERROR", message: "video_id must be 64-char lowercase hex" },
      { name: "non-hex video_id", overrides: { video_id: "g".repeat(64) }, code: "VALIDATION_ERROR", message: "video_id must be 64-char lowercase hex" },
      { name: "non-string video_id", overrides: { video_id: 42 }, code: "VALIDATION_ERROR", message: "video_id must be 64-char lowercase hex" },
      { name: "missing video_id", overrides: { video_id: undefined }, code: "VALIDATION_ERROR", message: "video_id must be 64-char lowercase hex" },
      { name: "42-char source_key", overrides: { source_key: "A".repeat(42) }, code: "VALIDATION_ERROR", message: "source_key must be 43-char base64url" },
      { name: "44-char source_key", overrides: { source_key: "A".repeat(44) }, code: "VALIDATION_ERROR", message: "source_key must be 43-char base64url" },
      { name: "padded source_key", overrides: { source_key: `${"A".repeat(42)}=` }, code: "VALIDATION_ERROR", message: "source_key must be 43-char base64url" },
      { name: "missing source_key", overrides: { source_key: undefined }, code: "VALIDATION_ERROR", message: "source_key must be 43-char base64url" },
      { name: "frame_count 0", overrides: { frame_count: 0 }, code: "VALIDATION_ERROR", message: "frame_count must be a positive integer" },
      { name: "frame_count negative", overrides: { frame_count: -5 }, code: "VALIDATION_ERROR", message: "frame_count must be a positive integer" },
      { name: "frame_count 1.5", overrides: { frame_count: 1.5 }, code: "VALIDATION_ERROR", message: "frame_count must be a positive integer" },
      { name: "frame_count string", overrides: { frame_count: "100" }, code: "VALIDATION_ERROR", message: "frame_count must be a positive integer" },
      { name: "missing frame_count", overrides: { frame_count: undefined }, code: "VALIDATION_ERROR", message: "frame_count must be a positive integer" },
      { name: "sample_rate 0", overrides: { sample_rate: 0 }, code: "VALIDATION_ERROR", message: "sample_rate must be a number in 1..30" },
      { name: "sample_rate 31", overrides: { sample_rate: 31 }, code: "VALIDATION_ERROR", message: "sample_rate must be a number in 1..30" },
      { name: "sample_rate string", overrides: { sample_rate: "10" }, code: "VALIDATION_ERROR", message: "sample_rate must be a number in 1..30" },
      { name: "missing sample_rate", overrides: { sample_rate: undefined }, code: "VALIDATION_ERROR", message: "sample_rate must be a number in 1..30" },
      { name: "keypoint_format tkp2", overrides: { keypoint_format: "tkp2" }, code: "UNSUPPORTED_FORMAT", message: "keypoint_format must be tkp1" },
      { name: "missing keypoint_format", overrides: { keypoint_format: undefined }, code: "UNSUPPORTED_FORMAT", message: "keypoint_format must be tkp1" },
    ];
    for (const { name, overrides, code, message } of cases) {
      const { result } = await register(client, overrides);
      expect(result.status).toBe(422);
      expect(result.json).toEqual({ error: { code, message, details: {} } });
      void name;
    }
    // Boundaries 1 and 30 pass validation.
    for (const rate of [1, 30]) {
      const { result } = await register(client, { sample_rate: rate });
      expect(result.status).toBe(201);
    }
  });

  test("an oversized body is 422 with details.maxBytes = 65536", async () => {
    const { client } = await setup();
    const result = await client.request("POST", "/sources", {
      rawBody: `{"video_id": "${"a".repeat(64)}", "pad": "${"x".repeat(65500)}"}`,
      headers: { "Content-Type": "application/json" },
    });
    expect(result.status).toBe(422);
    expect(result.json).toEqual({
      error: { code: "VALIDATION_ERROR", message: "The request body exceeds 65536 bytes", details: { maxBytes: 65536 } },
    });
  });

  test("success is 201 with the upload URL, and the rows are stored", async () => {
    const { client, userId } = await setup();
    const { result, body } = await register(client);
    expect(result.status).toBe(201);
    const uploadUrl = new URL(result.body.upload_url as string);
    expect(uploadUrl.host).toBe("turnip-conformance.conformance-account.r2.cloudflarestorage.com");
    expect(uploadUrl.pathname).toBe(`/staging/${body.video_id}.tkp1.gz`);
    for (const param of ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature"]) {
      expect(uploadUrl.searchParams.get(param)).toBeTruthy();
    }
    expect(uploadUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(uploadUrl.searchParams.get("X-Amz-Credential")).toMatch(/^conformance-access\/\d{8}\/auto\/s3\/aws4_request$/);
    const expiresMs = new Date(result.body.upload_expires_at as string).getTime() - Date.now();
    expect(expiresMs).toBeGreaterThan(890 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(900 * 1000);
    expect(result.body).toEqual({
      source_id: body.video_id,
      r2_key: `poses/${body.video_id}.tkp1.gz`,
      upload_url: result.body.upload_url,
      upload_expires_at: result.body.upload_expires_at,
      blob_present: false,
    });
    const row = await stack.db.one<{ frame_count: number; sample_rate: number; sha256: string | null }>(
      `SELECT frame_count, sample_rate, sha256 FROM sources WHERE id = $1`,
      [body.video_id],
    );
    expect(row).toEqual({ frame_count: 100, sample_rate: 10, sha256: null });
    const attribution = await stack.db.one(`SELECT user_id FROM source_attribution WHERE source_id = $1`, [body.video_id]);
    expect(attribution?.user_id).toBe(userId);
  });

  test("re-contribution with the same key is 200, fields updated, sha256 preserved, attribution re-pointed", async () => {
    const first = await setup();
    const second = await setup();
    const sourceId = await videoId(`sources-recontrib-${first.userId}`);
    const key = sourceKey();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    const firstResult = await first.client.post("/sources", {
      video_id: sourceId, source_key: key, frame_count: 100, sample_rate: 10, keypoint_format: "tkp1", storefront_country: "USA",
    });
    expect(firstResult.status).toBe(201);
    // Ingest the blob out-of-band, so the re-contribution must preserve the digest.
    await stack.db.query(`UPDATE sources SET sha256 = $1 WHERE id = $2`, [await sha256Hex(staged), sourceId]);
    stack.upstream.r2.put(`poses/${sourceId}.tkp1.gz`, staged, null, "application/gzip");
    const again = await second.client.post("/sources", {
      video_id: sourceId, source_key: key, frame_count: 200, sample_rate: 24, keypoint_format: "tkp1", storefront_country: "USA",
    });
    expect(again.status).toBe(200);
    expect(again.body.blob_present).toBe(true);
    const row = await stack.db.one<{ frame_count: number; sample_rate: number; sha256: string | null }>(
      `SELECT frame_count, sample_rate, sha256 FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(row?.frame_count).toBe(200);
    expect(row?.sample_rate).toBe(24);
    expect(row?.sha256).not.toBeNull();
    const attribution = await stack.db.one(`SELECT user_id FROM source_attribution WHERE source_id = $1`, [sourceId]);
    expect(attribution?.user_id).toBe(second.userId);
  });

  test("re-contribution under another key is 409 SOURCE_ALREADY_CLAIMED and the row is unchanged", async () => {
    const { client } = await setup();
    const sourceId = await videoId("sources-claimed");
    const first = await client.post("/sources", {
      video_id: sourceId, source_key: sourceKey(), frame_count: 100, sample_rate: 10, keypoint_format: "tkp1", storefront_country: "USA",
    });
    expect(first.status).toBe(201);
    const second = await client.post("/sources", {
      video_id: sourceId, source_key: sourceKey(), frame_count: 200, sample_rate: 24, keypoint_format: "tkp1", storefront_country: "USA",
    });
    expect(second.status).toBe(409);
    expect(second.json).toEqual({
      error: { code: "SOURCE_ALREADY_CLAIMED", message: "This source is already claimed under another key", details: {} },
    });
    const row = await stack.db.one<{ frame_count: number }>(`SELECT frame_count FROM sources WHERE id = $1`, [sourceId]);
    expect(row?.frame_count).toBe(100);
  });

  describe("GET /api/sources/:id", () => {
    test("401, and 404 for a missing key, a wrong key, a malformed id, and an unknown id", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-get-${userId}`);
      const key = sourceKey();
      const seeded = await seedSource(stack, sourceId, { userId, sourceKey: key });
      const anon = await stack.anonymous().get(`/sources/${sourceId}`);
      expect(anon.status).toBe(401);
      const noKey = await client.get(`/sources/${sourceId}`);
      expect(noKey.status).toBe(404);
      const wrongKey = await client.get(`/sources/${sourceId}`, { headers: { "Source-Key": sourceKey() } });
      expect(wrongKey.status).toBe(404);
      const malformed = await client.get(`/sources/not-an-id`, { headers: { "Source-Key": seeded.sourceKey } });
      expect(malformed.status).toBe(404);
      const unknown = await client.get(`/sources/${await videoId("sources-get-unknown")}`, { headers: { "Source-Key": seeded.sourceKey } });
      expect(unknown.status).toBe(404);
      for (const result of [noKey, wrongKey, malformed, unknown]) {
        expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
      }
    });

    test("success shape: source fields, trained_in, and clips with labels in order", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-shape-${userId}`);
      const key = sourceKey();
      await seedSource(stack, sourceId, { userId, sourceKey: key, frameCount: 100, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      const clipA = await seedClip(stack, sourceId, {
        startFrame: 0, endFrame: 10,
        labels: [{ name: "gainer", origin: "vocabulary" }, { name: "cork", origin: "typed" }],
      });
      const clipB = await seedClip(stack, sourceId, {
        startFrame: 10, endFrame: 20, labels: [{ name: "hook", origin: "vocabulary" }],
      });
      await seedModel(stack, "trick-v1", { trainingSourceIds: [sourceId], promotedAt: new Date(Date.now() - 1000) });
      await seedModel(stack, "trick-v2", { trainingSourceIds: [sourceId], promotedAt: new Date() });
      const result = await client.get(`/sources/${sourceId}`, { headers: { "Source-Key": key } });
      expect(result.status).toBe(200);
      const source = result.body.source as Record<string, unknown>;
      expect(source.id).toBe(sourceId);
      expect(source.frame_count).toBe(100);
      expect(source.sample_rate).toBe(10);
      expect(source.keypoint_format).toBe("tkp1");
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.trained_in).toEqual(["trick-v1", "trick-v2"]);
      expect(typeof source.created_at).toBe("string");
      expect(typeof source.updated_at).toBe("string");
      const clips = result.body.clips as { id: string; labels: { name: string; origin: string; taxonomy_version: number; created_at: string }[] }[];
      expect(clips.map((c) => c.id)).toEqual([clipA, clipB]);
      // Labels order by created_at: the seed inserted gainer before cork.
      expect(clips[0]!.labels.map((l) => l.name)).toEqual(["gainer", "cork"]);
      expect(clips[0]!.labels[0]).toMatchObject({ name: "gainer", origin: "vocabulary", taxonomy_version: 1 });
      expect(typeof clips[0]!.labels[0]!.created_at).toBe("string");
      expect(clips[1]!.labels.map((l) => l.name)).toEqual(["hook"]);
      // With equal created_at the tie-break is lower(name): cork before gainer.
      await stack.db.query(`UPDATE labels SET created_at = '2026-01-01T00:00:00Z' WHERE clip_id = $1`, [clipA]);
      const retied = await client.get(`/sources/${sourceId}`, { headers: { "Source-Key": key } });
      const retiedClips = retied.body.clips as { id: string; labels: { name: string }[] }[];
      expect(retiedClips[0]!.labels.map((l) => l.name)).toEqual(["cork", "gainer"]);
    });
  });

  describe("GET /api/sources/:id/pose", () => {
    test("404 cases, then 422 BLOB_MISSING while sha256 is NULL", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-pose-${userId}`);
      const key = sourceKey();
      await seedSource(stack, sourceId, { userId, sourceKey: key });
      const anon = await stack.anonymous().get(`/sources/${sourceId}/pose`);
      expect(anon.status).toBe(401);
      const noKey = await client.get(`/sources/${sourceId}/pose`);
      expect(noKey.status).toBe(404);
      const wrongKey = await client.get(`/sources/${sourceId}/pose`, { headers: { "Source-Key": sourceKey() } });
      expect(wrongKey.status).toBe(404);
      const missing = await client.get(`/sources/${sourceId}/pose`, { headers: { "Source-Key": key } });
      expect(missing.status).toBe(422);
      expect(missing.json).toEqual({
        error: { code: "BLOB_MISSING", message: "The pose blob is not ingested yet", details: {} },
      });
    });

    test("success returns a presigned GET; following it yields the canonical bytes", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-pose-ok-${userId}`);
      const key = sourceKey();
      const canonical = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 7 });
      await seedSource(stack, sourceId, { userId, sourceKey: key, canonicalBytes: canonical });
      const result = await client.get(`/sources/${sourceId}/pose`, { headers: { "Source-Key": key } });
      expect(result.status).toBe(200);
      const url = new URL(result.body.url as string);
      expect(url.host).toBe("turnip-conformance.conformance-account.r2.cloudflarestorage.com");
      expect(url.pathname).toBe(`/poses/${sourceId}.tkp1.gz`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      const expiresMs = new Date(result.body.expires_at as string).getTime() - Date.now();
      expect(expiresMs).toBeGreaterThan(890 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(900 * 1000);
      // Follow the URL through the fake's local endpoint.
      const fetched = await fetch(stack.upstream.r2.localUrl(result.body.url as string));
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer()).equals(canonical)).toBe(true);
    });
  });

  describe("DELETE /api/sources/:id", () => {
    test("404 cases", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-del-${userId}`);
      const key = sourceKey();
      await seedSource(stack, sourceId, { userId, sourceKey: key });
      expect((await stack.anonymous().delete(`/sources/${sourceId}`)).status).toBe(401);
      expect((await client.delete(`/sources/${sourceId}`)).status).toBe(404);
      expect((await client.delete(`/sources/${sourceId}`, { headers: { "Source-Key": sourceKey() } })).status).toBe(404);
      expect((await client.delete(`/sources/not-an-id`, { headers: { "Source-Key": key } })).status).toBe(404);
    });

    test("an R2 delete failure is 500 and the row survives", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-del-r2-${userId}`);
      const key = sourceKey();
      await seedSource(stack, sourceId, { userId, sourceKey: key, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      stack.upstream.r2.failNext("DELETE", 500);
      const result = await client.delete(`/sources/${sourceId}`, { headers: { "Source-Key": key } });
      expect(result.status).toBe(500);
      expect(result.json).toEqual({
        error: { code: "INTERNAL", message: "Could not delete the stored blob; retry later", details: {} },
      });
      const row = await stack.db.one(`SELECT id FROM sources WHERE id = $1`, [sourceId]);
      expect(row).toBeDefined();
      const retry = await client.delete(`/sources/${sourceId}`, { headers: { "Source-Key": key } });
      expect(retry.status).toBe(204);
    });

    test("success is 204: the row, clips, labels, and attribution cascade, both blobs gone", async () => {
      const { client, userId } = await setup();
      const sourceId = await videoId(`sources-del-ok-${userId}`);
      const key = sourceKey();
      const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
      await seedSource(stack, sourceId, { userId, sourceKey: key, canonicalBytes: staged });
      await seedStagedBlob(stack, sourceId, staged);
      const clipId = await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
      const result = await client.delete(`/sources/${sourceId}`, { headers: { "Source-Key": key } });
      expect(result.status).toBe(204);
      expect(result.text).toBe("");
      for (const [table, where] of [
        ["sources", `id = '${sourceId}'`],
        ["clips", `id = '${clipId}'`],
        ["source_attribution", `source_id = '${sourceId}'`],
      ] as const) {
        expect(await stack.db.query(`SELECT 1 FROM ${table} WHERE ${where}`)).toHaveLength(0);
      }
      expect(stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)).toBeUndefined();
      expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeUndefined();
    });
  });
});
