import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomSub, sourceKey, videoId } from "../harness/apple";
import { seedSession, seedSource } from "../harness/seed/contrib";
import { seedModel, seedTaxonomyRow, seedTrainingSourcePage } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";

describe("models", () => {
  // Publishes are global, so each test gets a fresh stack.
  let stack: Stack;
  beforeEach(async () => {
    stack = await startStack();
  });
  afterEach(() => stack?.stop());

  const publishBody = async (overrides: Record<string, unknown> = {}) => ({
    version: "trick-v1",
    taxonomy_version: 1,
    r2_key: "models/trick-v1.onnx",
    sha256: await sha256Hex(new TextEncoder().encode("model:trick-v1")),
    byte_size: 12345,
    min_client_version: "1.2.0",
    input_desc: { keypoints: 17 },
    output_desc: { tricks: ["cork"] },
    val_metrics: { accuracy: 0.9 },
    name_metrics: { cork: 0.95 },
    holdout_report_r2_key: "reports/trick-v1.json",
    training_run_id: "run-1",
    training_source_ids: [],
    ...overrides,
  });

  describe("GET /api/models/current", () => {
    test("404 NO_MODEL before the first promotion", async () => {
      const result = await stack.anonymous().get("/models/current");
      expect(result.status).toBe(404);
      expect(result.json).toEqual({
        error: { code: "NO_MODEL", message: "no model has been promoted yet", details: {} },
      });
    });

    test("an unpromoted model is ignored; the current model is the greatest promoted_at", async () => {
      await seedModel(stack, "trick-v0", { promotedAt: null });
      await seedModel(stack, "trick-v1", { promotedAt: new Date(Date.now() - 2000) });
      await seedModel(stack, "trick-v2", { promotedAt: new Date() });
      const result = await stack.anonymous().get("/models/current");
      expect(result.status).toBe(200);
      expect(result.body.version).toBe("trick-v2");
      expect(result.headers.get("etag")).toBe('"trick-v2"');
      expect(result.headers.get("cache-control")).toBe("max-age=300");
    });

    test("the full manifest shape, with the vocabulary scoped to the model's taxonomy version", async () => {
      // A v2 row exists, but the model trained on v1: its vocabulary is v1's.
      await seedTaxonomyRow(stack, "raiz", "raiz flip", 2);
      const sha = await sha256Hex(new TextEncoder().encode("model:trick-v1"));
      await seedModel(stack, "trick-v1", {
        taxonomyVersion: 1,
        r2Key: "models/trick-v1.onnx",
        sha256: sha,
        byteSize: 12345,
        minClientVersion: "1.2.0",
        inputDesc: { keypoints: 17 },
        outputDesc: { tricks: ["cork"] },
        valMetrics: { accuracy: 0.9 },
        nameMetrics: { cork: 0.95 },
        holdoutReportR2Key: "reports/trick-v1.json",
        trainingRunId: "run-1",
        promotedAt: new Date("2026-01-02T03:04:05.000Z"),
      });
      const result = await stack.anonymous().get("/models/current");
      expect(result.status).toBe(200);
      const url = new URL(result.body.url as string);
      expect(url.host).toBe("turnip-conformance.conformance-account.r2.cloudflarestorage.com");
      expect(url.pathname).toBe("/models/trick-v1.onnx");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(result.body).toEqual({
        version: "trick-v1",
        model_type: "trick-detection",
        taxonomy_version: 1,
        r2_key: "models/trick-v1.onnx",
        url: result.body.url,
        sha256: sha,
        byte_size: 12345,
        min_client_version: "1.2.0",
        input_desc: { keypoints: 17 },
        output_desc: { tricks: ["cork"] },
        holdout_report_r2_key: "reports/trick-v1.json",
        training_run_id: "run-1",
        val_metrics: { accuracy: 0.9 },
        name_metrics: { cork: 0.95 },
        vocabulary: [
          { canonical: "cartfull", aliases: ["cartfull"] },
          { canonical: "cork", aliases: ["cork", "corkscrew"] },
          { canonical: "gainer", aliases: ["gainer"] },
          { canonical: "hook", aliases: ["hook"] },
          { canonical: "scoot", aliases: ["scoot"] },
        ],
        promoted_at: "2026-01-02T03:04:05.000Z",
      });
    });

    test("byte_size null stays null in the manifest", async () => {
      await seedModel(stack, "trick-v1", { byteSize: null });
      const result = await stack.anonymous().get("/models/current");
      expect(result.body.byte_size).toBeNull();
    });
  });

  describe("POST /api/models", () => {
    test("401 with no key, a wrong key, and a user session token", async () => {
      const expected = {
        error: { code: "UNAUTHENTICATED", message: "Invalid pipeline key", details: {} },
      };
      const noKey = await stack.anonymous().post("/models", await publishBody());
      expect(noKey.status).toBe(401);
      expect(noKey.json).toEqual(expected);
      const wrongKey = await stack.anonymous().withBearer("wrong").post("/models", await publishBody());
      expect(wrongKey.status).toBe(401);
      const { client } = await seedSession(stack, randomSub());
      const userToken = await client.post("/models", await publishBody());
      expect(userToken.status).toBe(401);
      expect(userToken.json).toEqual(expected);
    });

    test("validation matrix: every field, 422 VALIDATION_ERROR with the validator message and no details", async () => {
      const cases: { name: string; overrides: Record<string, unknown>; message: string }[] = [
        { name: "version missing", overrides: { version: undefined }, message: "version must be a non-empty string" },
        { name: "version empty", overrides: { version: "" }, message: "version must be a non-empty string" },
        { name: "version blank", overrides: { version: "   " }, message: "version must be a non-empty string" },
        { name: "version 201 chars", overrides: { version: "v".repeat(201) }, message: "version must be a non-empty string" },
        { name: "taxonomy_version 0", overrides: { taxonomy_version: 0 }, message: "taxonomy_version must be a positive integer" },
        { name: "taxonomy_version -1", overrides: { taxonomy_version: -1 }, message: "taxonomy_version must be a positive integer" },
        { name: "taxonomy_version 1.5", overrides: { taxonomy_version: 1.5 }, message: "taxonomy_version must be a positive integer" },
        { name: "taxonomy_version string", overrides: { taxonomy_version: "1" }, message: "taxonomy_version must be a positive integer" },
        { name: "taxonomy_version missing", overrides: { taxonomy_version: undefined }, message: "taxonomy_version must be a positive integer" },
        { name: "r2_key missing", overrides: { r2_key: undefined }, message: "r2_key must be a non-empty string" },
        { name: "r2_key empty", overrides: { r2_key: "" }, message: "r2_key must be a non-empty string" },
        { name: "r2_key 1025 chars", overrides: { r2_key: "k".repeat(1025) }, message: "r2_key must be a non-empty string" },
        { name: "sha256 short", overrides: { sha256: "abc" }, message: "sha256 must be a 64-char lowercase hex digest" },
        { name: "sha256 uppercase", overrides: { sha256: "A".repeat(64) }, message: "sha256 must be a 64-char lowercase hex digest" },
        { name: "sha256 missing", overrides: { sha256: undefined }, message: "sha256 must be a 64-char lowercase hex digest" },
        { name: "byte_size -1", overrides: { byte_size: -1 }, message: "byte_size must be a non-negative integer when present" },
        { name: "byte_size 1.5", overrides: { byte_size: 1.5 }, message: "byte_size must be a non-negative integer when present" },
        { name: "byte_size string", overrides: { byte_size: "100" }, message: "byte_size must be a non-negative integer when present" },
        { name: "min_client_version number", overrides: { min_client_version: 12 }, message: "min_client_version must be a string when present" },
        { name: "min_client_version 51 chars", overrides: { min_client_version: "v".repeat(51) }, message: "min_client_version must be a string when present" },
        { name: "input_desc array", overrides: { input_desc: [] }, message: "input_desc must be a JSON object when present" },
        { name: "output_desc string", overrides: { output_desc: "x" }, message: "output_desc must be a JSON object when present" },
        { name: "val_metrics array", overrides: { val_metrics: [] }, message: "val_metrics must be a JSON object when present" },
        { name: "name_metrics null", overrides: { name_metrics: null }, message: "name_metrics must be a JSON object when present" },
        { name: "holdout_report_r2_key 1025 chars", overrides: { holdout_report_r2_key: "k".repeat(1025) }, message: "holdout_report_r2_key must be a string when present" },
        { name: "training_run_id 201 chars", overrides: { training_run_id: "r".repeat(201) }, message: "training_run_id must be a string when present" },
        { name: "training_source_ids not an array", overrides: { training_source_ids: "x" }, message: "training_source_ids must be an array of at most 1000; send the rest first with POST /api/models/training-sources" },
        { name: "training_source_ids 1001 ids", overrides: { training_source_ids: Array.from({ length: 1001 }, () => "a".repeat(64)) }, message: "training_source_ids must be an array of at most 1000; send the rest first with POST /api/models/training-sources" },
        { name: "training_source_ids bad id", overrides: { training_source_ids: ["not-an-id"] }, message: "training_source_ids must be 64-char lowercase hex source ids" },
      ];
      for (const { name, overrides, message } of cases) {
        const result = await stack.pipeline().post("/models", await publishBody(overrides));
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: { code: "VALIDATION_ERROR", message, details: {} },
        });
        void name;
      }
      // A non-object body is 422 with the same shape.
      const arrayBody = await stack.pipeline().request("POST", "/models", {
        rawBody: JSON.stringify([{ version: "x" }]),
        headers: { "Content-Type": "application/json" },
      });
      expect(arrayBody.status).toBe(422);
      expect(arrayBody.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "body must be a JSON object", details: {} },
      });
    });

    test("an oversized body is 422 with details.maxBytes = 131072", async () => {
      const result = await stack.pipeline().request("POST", "/models", {
        rawBody: `{"version": "trick-v1", "pad": "${"x".repeat(131100)}"}`,
        headers: { "Content-Type": "application/json" },
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "The request body exceeds 131072 bytes", details: { maxBytes: 131072 } },
      });
    });

    test("success is 201; only existing sources are recorded; dupes in the list dedupe", async () => {
      const { userId } = await seedSession(stack, randomSub());
      const firstId = await videoId(`models-publish-1-${userId}`);
      const secondId = await videoId(`models-publish-2-${userId}`);
      await seedSource(stack, firstId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      await seedSource(stack, secondId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      const unknownId = await videoId(`models-publish-unknown-${userId}`);
      const body = await publishBody({ training_source_ids: [firstId, secondId, secondId, unknownId] });
      const result = await stack.pipeline().post("/models", body);
      expect(result.status).toBe(201);
      expect(result.body).toEqual({
        id: expect.any(String),
        version: "trick-v1",
        promoted_at: expect.any(String),
        training_sources_recorded: 2,
      });
      const recorded = await stack.db.query<{ source_id: string }>(
        `SELECT source_id FROM model_training_sources WHERE model_version = 'trick-v1' ORDER BY source_id`,
        [],
      );
      expect(recorded.map((r) => r.source_id).sort()).toEqual([firstId, secondId].sort());
      const row = await stack.db.one<{ byte_size: number; min_client_version: string; input_desc: string }>(
        `SELECT byte_size, min_client_version, input_desc FROM models WHERE version = 'trick-v1'`,
        [],
      );
      expect(Number(row?.byte_size)).toBe(12345);
      expect(row?.min_client_version).toBe("1.2.0");
      expect(JSON.parse(row!.input_desc)).toEqual({ keypoints: 17 });
    });

    test("re-publish is 409 VERSION_EXISTS and records nothing", async () => {
      const first = await stack.pipeline().post("/models", await publishBody());
      expect(first.status).toBe(201);
      const { userId } = await seedSession(stack, randomSub());
      const sourceId = await videoId(`models-republish-${userId}`);
      await seedSource(stack, sourceId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      const second = await stack.pipeline().post("/models", await publishBody({ training_source_ids: [sourceId] }));
      expect(second.status).toBe(409);
      expect(second.json).toEqual({
        error: { code: "VERSION_EXISTS", message: "version is already published; bump the version instead", details: {} },
      });
      const recorded = await stack.db.query(`SELECT 1 FROM model_training_sources WHERE model_version = 'trick-v1'`);
      expect(recorded).toHaveLength(0);
    });

    test("staged pages join the publish — and pages for the version with a different sha256 are deleted too", async () => {
      const { userId } = await seedSession(stack, randomSub());
      const matchingId = await videoId(`models-page-match-${userId}`);
      const otherId = await videoId(`models-page-other-${userId}`);
      const inlineId = await videoId(`models-page-inline-${userId}`);
      for (const id of [matchingId, otherId, inlineId]) {
        await seedSource(stack, id, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      }
      const body = await publishBody({ training_source_ids: [inlineId] });
      const sha = body.sha256 as string;
      const otherSha = await sha256Hex(new TextEncoder().encode("model:other"));
      // A page for this version + this sha, and a page for this version +
      // a different sha (the design says the latter survives; the code
      // deletes every page for the version — the code is authoritative).
      await seedTrainingSourcePage(stack, "trick-v1", sha, matchingId);
      await seedTrainingSourcePage(stack, "trick-v1", otherSha, otherId);
      const result = await stack.pipeline().post("/models", body);
      expect(result.status).toBe(201);
      expect(result.body.training_sources_recorded).toBe(2);
      const recorded = await stack.db.query<{ source_id: string }>(
        `SELECT source_id FROM model_training_sources WHERE model_version = 'trick-v1' ORDER BY source_id`,
        [],
      );
      expect(recorded.map((r) => r.source_id).sort()).toEqual([inlineId, matchingId].sort());
      const pagesLeft = await stack.db.query(`SELECT 1 FROM model_training_source_pages WHERE model_version = 'trick-v1'`);
      expect(pagesLeft).toHaveLength(0);
    });
  });

  describe("POST /api/models/training-sources", () => {
    test("401 with no key", async () => {
      const result = await stack.anonymous().post("/models/training-sources", {
        version: "trick-v1",
        sha256: "a".repeat(64),
        training_source_ids: [],
      });
      expect(result.status).toBe(401);
    });

    test("validation: version, sha256, and the id list", async () => {
      const cases: { body: Record<string, unknown>; message: string }[] = [
        { body: { version: "", sha256: "a".repeat(64), training_source_ids: [] }, message: "version must be a non-empty string" },
        { body: { version: "v".repeat(201), sha256: "a".repeat(64), training_source_ids: [] }, message: "version must be a non-empty string" },
        { body: { version: "trick-v1", sha256: "abc", training_source_ids: [] }, message: "sha256 must be a 64-char lowercase hex digest" },
        { body: { version: "trick-v1", sha256: "a".repeat(64), training_source_ids: "x" }, message: "training_source_ids must be an array of at most 1000; send the rest first with POST /api/models/training-sources" },
        { body: { version: "trick-v1", sha256: "a".repeat(64), training_source_ids: ["bad"] }, message: "training_source_ids must be 64-char lowercase hex source ids" },
      ];
      for (const { body, message } of cases) {
        const result = await stack.pipeline().post("/models/training-sources", body);
        expect(result.status).toBe(422);
        expect(result.json).toEqual({ error: { code: "VALIDATION_ERROR", message, details: {} } });
      }
    });

    test("success stages only existing sources; pages for a published version are 409", async () => {
      const { userId } = await seedSession(stack, randomSub());
      const firstId = await videoId(`models-stage-1-${userId}`);
      const secondId = await videoId(`models-stage-2-${userId}`);
      await seedSource(stack, firstId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
      const unknownId = await videoId(`models-stage-unknown-${userId}`);
      const sha = "b".repeat(64);
      const result = await stack.pipeline().post("/models/training-sources", {
        version: "trick-v1",
        sha256: sha,
        training_source_ids: [firstId, secondId, secondId, unknownId],
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ version: "trick-v1", training_sources_staged: 1 });
      const pages = await stack.db.query<{ source_id: string }>(
        `SELECT source_id FROM model_training_source_pages WHERE model_version = 'trick-v1'`,
        [],
      );
      expect(pages.map((p) => p.source_id)).toEqual([firstId]);
      // Once published, staging more pages for the version is 409.
      const published = await stack.pipeline().post("/models", await publishBody());
      expect(published.status).toBe(201);
      const after = await stack.pipeline().post("/models/training-sources", {
        version: "trick-v1",
        sha256: sha,
        training_source_ids: [firstId],
      });
      expect(after.status).toBe(409);
      expect(after.json).toEqual({
        error: { code: "VERSION_EXISTS", message: "version is already published; bump the version instead", details: {} },
      });
    });
  });
});
