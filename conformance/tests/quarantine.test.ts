import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomSub, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedSession, seedSource, seedStagedBlob } from "../harness/seed/contrib";
import { seedQuarantine as seedQuarantineRow } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1 } from "../harness/tkp1";

describe("quarantine", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  const setupSource = async () => {
    const { userId } = await seedSession(stack, randomSub());
    const sourceId = await videoId(`quarantine-${userId}`);
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, { userId, sourceKey: sourceKey(), canonicalBytes: staged });
    await seedStagedBlob(stack, sourceId, staged);
    return { userId, sourceId };
  };

  test("401 with no key, a wrong key, and a user session token", async () => {
    const expected = {
      error: { code: "UNAUTHENTICATED", message: "Invalid pipeline key", details: {} },
    };
    const body = { source_ids: [await videoId("quarantine-auth")], reason: "regression" };
    expect((await stack.anonymous().post("/quarantine", body)).status).toBe(401);
    expect((await stack.anonymous().post("/quarantine", body)).json).toEqual(expected);
    expect((await stack.anonymous().withBearer("wrong").post("/quarantine", body)).status).toBe(401);
    const { client } = await seedSession(stack, randomSub());
    const userToken = await client.post("/quarantine", body);
    expect(userToken.status).toBe(401);
    expect(userToken.json).toEqual(expected);
  });

  test("validation: source_ids, reason, and metrics", async () => {
    const goodId = await videoId("quarantine-valid");
    const cases: { body: Record<string, unknown>; message: string; details: Record<string, unknown> }[] = [
      { body: { source_ids: [], reason: "x" }, message: "source_ids must be a non-empty array", details: { max: 10000 } },
      { body: { reason: "x" }, message: "source_ids must be a non-empty array", details: { max: 10000 } },
      { body: { source_ids: "x", reason: "x" }, message: "source_ids must be a non-empty array", details: { max: 10000 } },
      { body: { source_ids: Array.from({ length: 10001 }, () => goodId), reason: "x" }, message: "source_ids must be a non-empty array", details: { max: 10000 } },
      { body: { source_ids: ["not-an-id"], reason: "x" }, message: "source_ids must be 64-char lowercase hex video ids", details: { id: "not-an-id" } },
      { body: { source_ids: [goodId, "bad"], reason: "x" }, message: "source_ids must be 64-char lowercase hex video ids", details: { id: "bad" } },
      { body: { source_ids: [goodId], reason: "" }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { source_ids: [goodId], reason: "   " }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { source_ids: [goodId], reason: "x".repeat(1001) }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { source_ids: [goodId] }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { source_ids: [goodId], reason: "x", metrics: "nope" }, message: "metrics must be a JSON object or null", details: {} },
      { body: { source_ids: [goodId], reason: "x", metrics: [1] }, message: "metrics must be a JSON object or null", details: {} },
    ];
    for (const { body, message, details } of cases) {
      const result = await stack.pipeline().post("/quarantine", body);
      expect(result.status).toBe(422);
      expect(result.json).toEqual({ error: { code: "VALIDATION_ERROR", message, details } });
    }
    // A non-object body is 422 too.
    const arrayBody = await stack.pipeline().request("POST", "/quarantine", {
      rawBody: JSON.stringify([]),
      headers: { "Content-Type": "application/json" },
    });
    expect(arrayBody.status).toBe(422);
    expect(arrayBody.json).toEqual({
      error: { code: "VALIDATION_ERROR", message: "body must be a JSON object", details: {} },
    });
  });

  test("a body over 1 MiB is Bun's bare 413, not the route's 422", async () => {
    // The quarantine cap (1 MiB) equals Bun.serve's maxRequestBodySize, so
    // a body over it never reaches the handler's declared-length check:
    // Bun answers 413 first. The 422 path only fires for routes whose cap
    // sits below Bun's max (sources 64 KiB, models 128 KiB). The exact
    // 413 status and body are pinned in http.test.ts.
    const result = await stack.pipeline().request("POST", "/quarantine", {
      rawBody: `{"source_ids": ["${"a".repeat(64)}"], "reason": "${"x".repeat(1048500)}"}`,
      headers: { "Content-Type": "application/json" },
    });
    expect(result.status).toBe(413);
  });

  test("success: quarantined, already_open, and unknown; dupes dedupe; the reason is stored trimmed", async () => {
    const first = await setupSource();
    const second = await setupSource();
    const unknownId = await videoId(`quarantine-unknown-${first.userId}`);
    const result = await stack.pipeline().post("/quarantine", {
      source_ids: [first.sourceId, second.sourceId, first.sourceId, unknownId],
      reason: "  regression in the nightly run  ",
      metrics: { accuracy: 0.1 },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      quarantined: [first.sourceId, second.sourceId],
      already_open: [],
      unknown: [unknownId],
    });
    const row = await stack.db.one<{ reason: string; metrics: string }>(
      `SELECT reason, metrics::text AS metrics FROM data_quarantine WHERE source_id = $1`,
      [first.sourceId],
    );
    expect(row?.reason).toBe("regression in the nightly run");
    expect(JSON.parse(row!.metrics)).toEqual({ accuracy: 0.1 });
    // Resubmission: both already open, nothing new.
    const again = await stack.pipeline().post("/quarantine", {
      source_ids: [first.sourceId, second.sourceId],
      reason: "regression",
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ quarantined: [], already_open: [first.sourceId, second.sourceId], unknown: [] });
  });

  test("metrics null is stored as null", async () => {
    const { sourceId } = await setupSource();
    const result = await stack.pipeline().post("/quarantine", {
      source_ids: [sourceId],
      reason: "regression",
      metrics: null,
    });
    expect(result.status).toBe(200);
    const row = await stack.db.one<{ metrics: string | null }>(
      `SELECT metrics::text AS metrics FROM data_quarantine WHERE source_id = $1`,
      [sourceId],
    );
    expect(row?.metrics).toBe("null");
  });

  describe("POST /api/quarantine/:id/release", () => {
    test("401, and 404 for a bad id, an unknown id, and a source with no open quarantine", async () => {
      const { sourceId } = await setupSource();
      const anon = await stack.anonymous().post(`/quarantine/${sourceId}/release`, {});
      expect(anon.status).toBe(401);
      const badId = await stack.pipeline().post(`/quarantine/not-an-id/release`, {});
      expect(badId.status).toBe(404);
      const unknown = await stack.pipeline().post(`/quarantine/${await videoId("quarantine-release-unknown")}/release`, {});
      expect(unknown.status).toBe(404);
      const noOpen = await stack.pipeline().post(`/quarantine/${sourceId}/release`, {});
      expect(noOpen.status).toBe(404);
      for (const result of [badId, unknown, noOpen]) {
        expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
      }
    });

    test("success releases the row; a second release is 404", async () => {
      const { sourceId } = await setupSource();
      await seedQuarantineRow(stack, sourceId, { reason: "regression" });
      const result = await stack.pipeline().post(`/quarantine/${sourceId}/release`, {});
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ source_id: sourceId, resolution: "released" });
      const row = await stack.db.one<{ resolved_at: string; resolution: string }>(
        `SELECT resolved_at, resolution FROM data_quarantine WHERE source_id = $1`,
        [sourceId],
      );
      expect(row?.resolution).toBe("released");
      expect(row?.resolved_at).toBeTruthy();
      const again = await stack.pipeline().post(`/quarantine/${sourceId}/release`, {});
      expect(again.status).toBe(404);
    });
  });

  describe("POST /api/quarantine/:id/purge", () => {
    test("401, and 404 for a bad id, an unknown id, and a source with no open quarantine", async () => {
      const { sourceId } = await setupSource();
      const anon = await stack.anonymous().post(`/quarantine/${sourceId}/purge`, {});
      expect(anon.status).toBe(401);
      const badId = await stack.pipeline().post(`/quarantine/not-an-id/purge`, {});
      expect(badId.status).toBe(404);
      const unknown = await stack.pipeline().post(`/quarantine/${await videoId("quarantine-purge-unknown")}/purge`, {});
      expect(unknown.status).toBe(404);
      const noOpen = await stack.pipeline().post(`/quarantine/${sourceId}/purge`, {});
      expect(noOpen.status).toBe(404);
    });

    test("an R2 delete failure is 500 and the row survives; a retry succeeds", async () => {
      const { sourceId } = await setupSource();
      await seedQuarantineRow(stack, sourceId, { reason: "poisoned" });
      stack.upstream.r2.failNext("DELETE", 500);
      const result = await stack.pipeline().post(`/quarantine/${sourceId}/purge`, {});
      expect(result.status).toBe(500);
      expect(result.json).toEqual({
        error: { code: "INTERNAL", message: "Could not delete the stored blob; retry later", details: {} },
      });
      expect(await stack.db.one(`SELECT id FROM sources WHERE id = $1`, [sourceId])).toBeDefined();
      const retry = await stack.pipeline().post(`/quarantine/${sourceId}/purge`, {});
      expect(retry.status).toBe(204);
    });

    test("success is 204: the source row, its clips, and the quarantine row are gone, both blobs deleted", async () => {
      const { sourceId } = await setupSource();
      const clipId = await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
      await seedQuarantineRow(stack, sourceId, { reason: "poisoned" });
      const result = await stack.pipeline().post(`/quarantine/${sourceId}/purge`, {});
      expect(result.status).toBe(204);
      expect(result.text).toBe("");
      for (const [table, where] of [
        ["sources", `id = '${sourceId}'`],
        ["clips", `id = '${clipId}'`],
        ["data_quarantine", `source_id = '${sourceId}'`],
      ] as const) {
        expect(await stack.db.query(`SELECT 1 FROM ${table} WHERE ${where}`)).toHaveLength(0);
      }
      expect(stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)).toBeUndefined();
      expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeUndefined();
    });
  });
});
