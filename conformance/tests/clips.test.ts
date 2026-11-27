import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, randomSub, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedSession, seedSource } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";
import type { ApiClient, ApiResult } from "../harness/client";

describe("clips", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  /** A consented client plus an ingested 100-frame source. */
  const setup = async (frameCount = 100) => {
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`clips-${userId}`);
    const key = sourceKey();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, { userId, sourceKey: key, frameCount, canonicalBytes: staged });
    return { client, userId, sourceId, key, staged };
  };

  const clipBody = (sourceId: string, key: string, overrides: Record<string, unknown> = {}) => ({
    clip_id: crypto.randomUUID(),
    source_id: sourceId,
    source_key: key,
    start_frame: 0,
    end_frame: 10,
    auto_detected: false,
    ...overrides,
  });

  const valid = (r: { status: number; json: unknown }) => {
    expect(r.status).toBe(422);
    return r.json as { error: { code: string; message: string; details: Record<string, unknown> } };
  };

  test("401 anonymous, 403 blocked, 403 without consent", async () => {
    const { sourceId, key } = await setup();
    const anon = await stack.anonymous().post("/clips", { clips: [clipBody(sourceId, key)] });
    expect(anon.status).toBe(401);
    const blockedSub = randomSub();
    const { client: blockedClient } = await seedSession(stack, blockedSub, { isBlocked: true });
    const blocked = await blockedClient.post("/clips", { clips: [clipBody(sourceId, key)] });
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({ error: { code: "ACCOUNT_BLOCKED", message: "Account blocked", details: {} } });
    const { client } = await seedSession(stack, randomSub());
    const unconsented = await client.post("/clips", { clips: [clipBody(sourceId, key)] });
    expect(unconsented.status).toBe(403);
    expect(unconsented.json).toEqual({
      error: { code: "CONSENT_REQUIRED", message: "Agree to the current contribution disclosure first", details: { disclosure_version: 3 } },
    });
  });

  test("clips must be an array", async () => {
    const { client, sourceId, key } = await setup();
    for (const clips of [undefined, null, "nope", { clip_id: "x" }]) {
      const result = await client.post("/clips", { clips });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "clips must be an array", details: {} },
      });
    }
    void sourceId;
    void key;
  });

  test("validation matrix: every field of one clip, with details {index, field}", async () => {
    const { client, sourceId, key } = await setup();
    const cases: { name: string; overrides: Record<string, unknown>; field: string; message: string }[] = [
      { name: "clip_id v1", overrides: { clip_id: "11111111-1111-1111-8111-111111111111" }, field: "clip_id", message: "must be a uuid" },
      { name: "clip_id v3", overrides: { clip_id: "11111111-1111-3111-8111-111111111111" }, field: "clip_id", message: "must be a uuid" },
      { name: "clip_id v5", overrides: { clip_id: "11111111-1111-5111-8111-111111111111" }, field: "clip_id", message: "must be a uuid" },
      { name: "clip_id non-uuid", overrides: { clip_id: "not-a-uuid" }, field: "clip_id", message: "must be a uuid" },
      { name: "clip_id missing", overrides: { clip_id: undefined }, field: "clip_id", message: "must be a uuid" },
      { name: "source_id short", overrides: { source_id: "abc" }, field: "source_id", message: "must be 64-char lowercase hex" },
      { name: "source_key short", overrides: { source_key: "A".repeat(42) }, field: "source_key", message: "must be 43-char base64url" },
      { name: "start_frame -1", overrides: { start_frame: -1 }, field: "start_frame", message: "must be an integer >= 0" },
      { name: "start_frame 1.5", overrides: { start_frame: 1.5 }, field: "start_frame", message: "must be an integer >= 0" },
      { name: "start_frame missing", overrides: { start_frame: undefined }, field: "start_frame", message: "must be an integer >= 0" },
      { name: "end_frame == start_frame", overrides: { start_frame: 5, end_frame: 5 }, field: "end_frame", message: "must be an integer > start_frame" },
      { name: "end_frame < start_frame", overrides: { start_frame: 5, end_frame: 4 }, field: "end_frame", message: "must be an integer > start_frame" },
      { name: "end_frame 1.5", overrides: { end_frame: 1.5 }, field: "end_frame", message: "must be an integer > start_frame" },
      { name: "auto_detected string", overrides: { auto_detected: "yes" }, field: "auto_detected", message: "must be a boolean" },
      { name: "auto_detected missing", overrides: { auto_detected: undefined }, field: "auto_detected", message: "must be a boolean" },
      { name: "labels not an array", overrides: { labels: "cork" }, field: "labels", message: "must be an array of {name, origin} objects" },
      { name: "label entry without a string name", overrides: { labels: [{ origin: "typed" }] }, field: "labels[0]", message: "must be an object with a string name" },
      { name: "label entry with a bad origin", overrides: { labels: [{ name: "cork", origin: "guess" }] }, field: "labels[0].origin", message: "must be one of typed, vocabulary, model" },
      { name: "proposal_model_version empty", overrides: { proposal_model_version: "" }, field: "proposal_model_version", message: "must be a non-empty string or null" },
      { name: "suggested_names not an array", overrides: { suggested_names: "cork" }, field: "suggested_names", message: "must be an array of strings" },
      { name: "suggested_names with a non-string", overrides: { suggested_names: [42] }, field: "suggested_names", message: "must be an array of strings" },
      { name: "suggestions_withheld not a boolean", overrides: { suggestions_withheld: "yes" }, field: "suggestions_withheld", message: "must be a boolean" },
    ];
    for (const { name, overrides, field, message } of cases) {
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key, overrides)] });
      const body = valid(result);
      expect(body.error).toEqual({
        code: "VALIDATION_ERROR",
        message: `clips[0].${field}: ${message}`,
        details: { index: 0, field },
      });
      void name;
    }
    // The index in the message and details follows the failing clip.
    const secondBad = await client.post("/clips", {
      clips: [clipBody(sourceId, key), clipBody(sourceId, key, { start_frame: -1 })],
    });
    expect(secondBad.json).toEqual({
      error: { code: "VALIDATION_ERROR", message: "clips[1].start_frame: must be an integer >= 0", details: { index: 1, field: "start_frame" } },
    });
  });

  test("provenance consistency: suggestions, withheld, and model origin all need the model", async () => {
    const { client, sourceId, key } = await setup();
    const cases: { overrides: Record<string, unknown>; field: string; message: string }[] = [
      { overrides: { suggested_names: ["cork"] }, field: "suggested_names", message: "needs a proposal_model_version" },
      { overrides: { suggestions_withheld: true }, field: "suggestions_withheld", message: "needs a proposal_model_version" },
      { overrides: { labels: [{ name: "cork", origin: "model" }] }, field: "labels", message: 'origin "model" needs a proposal_model_version' },
      {
        overrides: { proposal_model_version: "trick-v1", suggestions_withheld: true, labels: [{ name: "cork", origin: "model" }] },
        field: "labels",
        message: 'origin "model" is impossible on a clip whose suggestions were withheld',
      },
    ];
    for (const { overrides, field, message } of cases) {
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key, overrides)] });
      expect(result.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: `clips[0].${field}: ${message}`, details: { index: 0, field } },
      });
    }
  });

  test("an unknown label name fails the batch with UNKNOWN_LABEL before anything is read or written", async () => {
    const { client, sourceId, key } = await setup();
    const clipId = crypto.randomUUID();
    const getBefore = stack.upstream.hub.seen("turnip-conformance.conformance-account.r2.cloudflarestorage.com").length;
    const result = await client.post("/clips", {
      clips: [
        clipBody(sourceId, key, { clip_id: clipId, labels: [{ name: "cork", origin: "typed" }] }),
        clipBody(sourceId, key, { labels: [{ name: "double backflip", origin: "typed" }] }),
      ],
    });
    expect(result.status).toBe(422);
    expect(result.json).toEqual({
      error: {
        code: "UNKNOWN_LABEL",
        message: "Not in the vocabulary: double backflip",
        details: { index: 1, field: "labels", names: ["double backflip"] },
      },
    });
    // Nothing was written, and no blob was fetched from R2.
    expect(await stack.db.query(`SELECT 1 FROM clips WHERE id = $1`, [clipId])).toHaveLength(0);
    expect(stack.upstream.hub.seen("turnip-conformance.conformance-account.r2.cloudflarestorage.com").length).toBe(getBefore);
  });

  test("unknown source, wrong key, and a clip id on another source are all 404", async () => {
    const first = await setup();
    const second = await setup();
    const unknown = await first.client.post("/clips", {
      clips: [clipBody(await videoId("clips-unknown-source"), sourceKey())],
    });
    expect(unknown.status).toBe(404);
    const wrongKey = await first.client.post("/clips", {
      clips: [clipBody(first.sourceId, sourceKey())],
    });
    expect(wrongKey.status).toBe(404);
    const clipId = await seedClip(stack, second.sourceId, {});
    const wrongSource = await first.client.post("/clips", {
      clips: [clipBody(first.sourceId, first.key, { clip_id: clipId })],
    });
    expect(wrongSource.status).toBe(404);
    for (const result of [unknown, wrongKey, wrongSource]) {
      expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
    }
  });

  test("end_frame past the source frame_count is 422 naming the bound", async () => {
    const { client, sourceId, key } = await setup(100);
    const result = await client.post("/clips", { clips: [clipBody(sourceId, key, { start_frame: 90, end_frame: 101 })] });
    expect(result.status).toBe(422);
    expect(result.json).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "clips[0]: end_frame must be > start_frame and <= source frame_count (100)",
        details: { index: 0, field: "end_frame" },
      },
    });
    const ok = await client.post("/clips", { clips: [clipBody(sourceId, key, { start_frame: 90, end_frame: 100 })] });
    expect(ok.status).toBe(200);
  });

  describe("blob gates", () => {
    test("sha256 NULL is 422 BLOB_MISSING", async () => {
      const { client, userId } = await seedSession(stack, randomSub());
      await consented(client);
      const sourceId = await videoId(`clips-blob-null-${userId}`);
      const key = sourceKey();
      await seedSource(stack, sourceId, { userId, sourceKey: key });
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key)] });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "BLOB_MISSING", message: `source ${sourceId}: blob not ingested yet`, details: {} },
      });
    });

    test("a fake blob whose digest differs is 422 BLOB_DIGEST_MISMATCH", async () => {
      const { client, userId } = await seedSession(stack, randomSub());
      await consented(client);
      const sourceId = await videoId(`clips-blob-digest-${userId}`);
      const key = sourceKey();
      const canonical = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
      await seedSource(stack, sourceId, { userId, sourceKey: key, canonicalBytes: canonical });
      // Swap the stored bytes for different ones without touching sha256.
      stack.upstream.r2.put(`poses/${sourceId}.tkp1.gz`, encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 99 }), null, "application/gzip");
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key)] });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "BLOB_DIGEST_MISMATCH", message: `source ${sourceId}: stored blob digest mismatch`, details: {} },
      });
    });

    test("a fake GET 404 is 422 BLOB_MISSING naming the r2 key", async () => {
      const { client, userId } = await seedSession(stack, randomSub());
      await consented(client);
      const sourceId = await videoId(`clips-blob-404-${userId}`);
      const key = sourceKey();
      const canonical = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
      await seedSource(stack, sourceId, { userId, sourceKey: key, sha256: await sha256Hex(canonical) });
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key)] });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "BLOB_MISSING", message: `source ${sourceId}: blob not found at poses/${sourceId}.tkp1.gz`, details: {} },
      });
    });

    test("a blob streaming past 64 MiB is 422 BLOB_TOO_LARGE", async () => {
      const { client, userId } = await seedSession(stack, randomSub());
      await consented(client);
      const sourceId = await videoId(`clips-blob-large-${userId}`);
      const key = sourceKey();
      const canonical = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
      await seedSource(stack, sourceId, { userId, sourceKey: key, canonicalBytes: canonical });
      stack.upstream.r2.lieAboutLength(`poses/${sourceId}.tkp1.gz`, 64 * 1024 * 1024 + 1);
      const result = await client.post("/clips", { clips: [clipBody(sourceId, key)] });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "BLOB_TOO_LARGE", message: `source ${sourceId}: blob exceeds 67108864 bytes`, details: {} },
      });
    });
  });

  test("a body over 1 MiB is Bun's bare 413, not the route's 422", async () => {
    // The clips cap (1 MiB) equals Bun.serve's maxRequestBodySize, so a
    // body over it never reaches the handler's declared-length check: Bun
    // answers 413 first. The exact 413 status and body are pinned in
    // http.test.ts.
    const { client, sourceId, key } = await setup();
    const big = "x".repeat(1024 * 1024 + 100);
    const result = await client.request("POST", "/clips", {
      rawBody: JSON.stringify({ clips: [{ ...clipBody(sourceId, key), labels: [{ name: big, origin: "typed" }] }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(result.status).toBe(413);
  });

  test("batch atomicity: a second clip failing validation or blob verification stores nothing", async () => {
    const { client, sourceId, key } = await setup();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const failed = await client.post("/clips", {
      clips: [
        clipBody(sourceId, key, { clip_id: firstId, labels: [{ name: "cork", origin: "typed" }] }),
        clipBody(sourceId, key, { clip_id: secondId, start_frame: -1 }),
      ],
    });
    expect(failed.status).toBe(422);
    expect(await stack.db.query(`SELECT 1 FROM clips WHERE id = ANY($1::uuid[])`, [`{${firstId},${secondId}}`])).toHaveLength(0);
    // Blob failure on the second source's clip stores nothing either.
    const { client: otherClient, userId: otherUser } = await seedSession(stack, randomSub());
    await consented(otherClient);
    const otherSourceId = await videoId(`clips-atomic-${otherUser}`);
    const otherKey = sourceKey();
    await seedSource(stack, otherSourceId, { userId: otherUser, sourceKey: otherKey });
    const blobFailed = await client.post("/clips", {
      clips: [
        clipBody(sourceId, key, { clip_id: firstId, labels: [{ name: "cork", origin: "typed" }] }),
        clipBody(otherSourceId, otherKey, { clip_id: secondId }),
      ],
    });
    expect(blobFailed.status).toBe(422);
    expect(blobFailed.json).toEqual({
      error: { code: "BLOB_MISSING", message: `source ${otherSourceId}: blob not ingested yet`, details: {} },
    });
    expect(await stack.db.query(`SELECT 1 FROM clips WHERE id = ANY($1::uuid[])`, [`{${firstId},${secondId}}`])).toHaveLength(0);
  });

  test("success: clips upsert, label sets replace, provenance is stored, attribution recorded", async () => {
    const { client, userId, sourceId, key } = await setup();
    const clipId = crypto.randomUUID();
    const result = await client.post("/clips", {
      clips: [
        clipBody(sourceId, key, {
          clip_id: clipId,
          start_frame: 5,
          end_frame: 15,
          auto_detected: true,
          proposal_model_version: "trick-v1",
          suggested_names: ["cork", "gainer"],
          labels: [
            { name: "  CORK  ", origin: "model" },
            { name: "cork", origin: "typed" },
            { name: "gainer", origin: "vocabulary" },
            { name: "   ", origin: "typed" },
          ],
        }),
      ],
    });
    expect(result.status).toBe(200);
    // Dedupe: case-insensitive collapse keeps the alphabetically-first casing
    // then origin, in first-seen order; the blank entry is dropped.
    expect(result.body).toEqual({
      clips: [
        {
          clip_id: clipId,
          labels: [
            { name: "CORK", origin: "model" },
            { name: "gainer", origin: "vocabulary" },
          ],
          taxonomy_version: 1,
        },
      ],
    });
    const row = await stack.db.one<{ start_frame: number; end_frame: number; auto_detected: boolean; proposal_model_version: string; suggested_names: string[]; suggestions_withheld: boolean }>(
      `SELECT start_frame, end_frame, auto_detected, proposal_model_version, suggested_names, suggestions_withheld FROM clips WHERE id = $1`,
      [clipId],
    );
    expect(row).toEqual({
      start_frame: 5,
      end_frame: 15,
      auto_detected: true,
      proposal_model_version: "trick-v1",
      suggested_names: ["cork", "gainer"],
      suggestions_withheld: false,
    });
    const labels = await stack.db.query<{ trick_name: string; origin: string; taxonomy_version: number }>(
      `SELECT trick_name, origin, taxonomy_version FROM labels WHERE clip_id = $1 ORDER BY trick_name`,
      [clipId],
    );
    expect(labels).toEqual([
      { trick_name: "CORK", origin: "model", taxonomy_version: 1 },
      { trick_name: "gainer", origin: "vocabulary", taxonomy_version: 1 },
    ]);
    const attribution = await stack.db.one(`SELECT user_id FROM source_attribution WHERE source_id = $1`, [sourceId]);
    expect(attribution?.user_id).toBe(userId);
    // Re-submitting the same clip replaces the label set; an empty set clears it.
    const replaced = await client.post("/clips", {
      clips: [clipBody(sourceId, key, { clip_id: clipId, labels: [{ name: "hook", origin: "typed" }] })],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ clips: [{ clip_id: clipId, labels: [{ name: "hook", origin: "typed" }], taxonomy_version: 1 }] });
    const cleared = await client.post("/clips", { clips: [clipBody(sourceId, key, { clip_id: clipId, labels: [] })] });
    expect(cleared.status).toBe(200);
    expect(await stack.db.query(`SELECT 1 FROM labels WHERE clip_id = $1`, [clipId])).toHaveLength(0);
  });

  test("blob-verification slots: 2 concurrent + 8 queued, the 11th concurrent submission is 429", async () => {
    const { client, sourceId, key } = await setup();
    const r2Host = "turnip-conformance.conformance-account.r2.cloudflarestorage.com";
    const getCount = () => stack.upstream.hub.seen(r2Host).filter((r) => r.method === "GET").length;
    const getsBefore = getCount();
    const release = stack.upstream.r2.gateGet(`poses/${sourceId}.tkp1.gz`);
    // Fire all 11 at once: exactly one of them must be the 11th arrival and
    // answer 429, whichever it is. The 429 proves the queue was full, so
    // the gate may be released as soon as it is observed — no deadlock.
    const settled: ApiResult[] = [];
    const submissions: Promise<void>[] = [];
    for (let i = 0; i < 11; i++) {
      submissions.push(
        client.post("/clips", { clips: [clipBody(sourceId, key)] }).then(
          (r) => {
            settled.push(r);
          },
          (e) => {
            throw e;
          },
        ),
      );
    }
    // Wait until two verifications are holding their slots behind the gate.
    await stack.waitFor(() => getCount() >= getsBefore + 2, { timeoutMs: 5000 });
    await stack.waitFor(() => settled.filter((r) => r.status === 429).length >= 1, { timeoutMs: 5000, what: "a 429 among the concurrent submissions" });
    const refused = settled.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.json).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests", details: {} },
    });
    expect(refused[0]!.headers.get("retry-after")).toBe("5");
    release();
    await Promise.all(submissions);
    const statuses = settled.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
  });

  describe("POST /api/clips/:id/labels", () => {
    const setupClip = async (overrides: Record<string, unknown> = {}) => {
      const ctx = await setup();
      const clipId = await seedClip(stack, ctx.sourceId, {
        startFrame: 0,
        endFrame: 10,
        proposalModelVersion: (overrides.proposal_model_version as string | null) ?? null,
        suggestedNames: (overrides.suggested_names as string[]) ?? [],
        suggestionsWithheld: (overrides.suggestions_withheld as boolean) ?? false,
      });
      return { ...ctx, clipId };
    };

    test("401, and 404 for a bad UUID, an unknown clip, and a wrong key", async () => {
      const { client, sourceId, key, clipId } = await setupClip();
      const anon = await stack.anonymous().post(`/clips/${clipId}/labels`, { source_key: key, labels: [] });
      expect(anon.status).toBe(401);
      const badUuid = await client.post(`/clips/not-a-uuid/labels`, { source_key: key, labels: [] });
      expect(badUuid.status).toBe(404);
      const unknown = await client.post(`/clips/${crypto.randomUUID()}/labels`, { source_key: key, labels: [] });
      expect(unknown.status).toBe(404);
      const wrongKey = await client.post(`/clips/${clipId}/labels`, { source_key: sourceKey(), labels: [] });
      expect(wrongKey.status).toBe(404);
      for (const result of [badUuid, unknown, wrongKey]) {
        expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
      }
      void sourceId;
    });

    test("source_key shape, label shape, and unknown names are 422", async () => {
      const { client, key, clipId } = await setupClip();
      const badKey = await client.post(`/clips/${clipId}/labels`, { source_key: "short", labels: [] });
      expect(badKey.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "source_key must be 43-char base64url", details: {} },
      });
      const badLabel = await client.post(`/clips/${clipId}/labels`, {
        source_key: key,
        labels: [{ name: "cork", origin: "guess" }],
      });
      expect(badLabel.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "labels[0].origin: must be one of typed, vocabulary, model",
          details: { field: "labels[0].origin" },
        },
      });
      const unknown = await client.post(`/clips/${clipId}/labels`, {
        source_key: key,
        labels: [{ name: "double backflip", origin: "typed" }],
      });
      expect(unknown.json).toEqual({
        error: { code: "UNKNOWN_LABEL", message: "Not in the vocabulary: double backflip", details: { field: "labels", names: ["double backflip"] } },
      });
    });

    test("origin model on a clip contributed without a model is 422 (the clip's own provenance)", async () => {
      const { client, key, clipId } = await setupClip();
      const result = await client.post(`/clips/${clipId}/labels`, {
        source_key: key,
        labels: [{ name: "cork", origin: "model" }],
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: 'labels: origin "model" needs a proposal_model_version',
          details: { field: "labels" },
        },
      });
    });

    test("success replaces the set, records attribution, and an empty array clears it", async () => {
      const { client, userId, sourceId, key, clipId } = await setupClip({
        proposal_model_version: "trick-v1",
        suggested_names: ["cork"],
      });
      const result = await client.post(`/clips/${clipId}/labels`, {
        source_key: key,
        labels: [{ name: "cork", origin: "model" }],
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        clip_id: clipId,
        labels: [{ name: "cork", origin: "model" }],
        taxonomy_version: 1,
      });
      const labels = await stack.db.query(`SELECT trick_name FROM labels WHERE clip_id = $1`, [clipId]);
      expect(labels).toHaveLength(1);
      const attribution = await stack.db.one(`SELECT user_id FROM source_attribution WHERE source_id = $1`, [sourceId]);
      expect(attribution?.user_id).toBe(userId);
      const cleared = await client.post(`/clips/${clipId}/labels`, { source_key: key, labels: [] });
      expect(cleared.status).toBe(200);
      expect(await stack.db.query(`SELECT 1 FROM labels WHERE clip_id = $1`, [clipId])).toHaveLength(0);
    });
  });
});
