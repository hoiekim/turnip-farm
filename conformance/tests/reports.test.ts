import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomSub, videoId } from "../harness/apple";
import { seedClip, seedSession, seedSource } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1 } from "../harness/tkp1";

describe("reports", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  test("401 anonymous, 403 blocked; consent is NOT required", async () => {
    const anon = await stack.anonymous().post("/reports", {
      target_type: "source",
      target_id: await videoId("reports-anon"),
      reason: "bad data",
    });
    expect(anon.status).toBe(401);
    const blockedSub = randomSub();
    const { client: blockedClient } = await seedSession(stack, blockedSub, { isBlocked: true });
    const blocked = await blockedClient.post("/reports", {
      target_type: "source",
      target_id: await videoId("reports-blocked"),
      reason: "bad data",
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({ error: { code: "ACCOUNT_BLOCKED", message: "Account blocked", details: {} } });
    const { client } = await seedSession(stack, randomSub());
    const ok = await client.post("/reports", {
      target_type: "source",
      target_id: await videoId("reports-unconsented"),
      reason: "bad data",
    });
    expect(ok.status).toBe(201);
  });

  test("validation: target_type, target_id per type, and reason", async () => {
    const { client } = await seedSession(stack, randomSub());
    const cases: { body: Record<string, unknown>; message: string; details: Record<string, unknown> }[] = [
      { body: { target_type: "user", target_id: "x", reason: "r" }, message: "target_type must be source, clip, or label", details: { allowed: ["source", "clip", "label"] } },
      { body: { target_id: "x", reason: "r" }, message: "target_type must be source, clip, or label", details: { allowed: ["source", "clip", "label"] } },
      { body: { target_type: "source", target_id: "abc", reason: "r" }, message: "target_id must be a 64-char lowercase hex video id for a source", details: {} },
      { body: { target_type: "source", reason: "r" }, message: "target_id must be a 64-char lowercase hex video id for a source", details: {} },
      { body: { target_type: "clip", target_id: "not-a-uuid", reason: "r" }, message: "target_id must be a UUID for a clip", details: {} },
      { body: { target_type: "clip", target_id: "11111111-1111-1111-8111-111111111111", reason: "r" }, message: "target_id must be a UUID for a clip", details: {} },
      { body: { target_type: "label", target_id: "not-a-uuid", reason: "r" }, message: "target_id must be a UUID for a label", details: {} },
      { body: { target_type: "source", target_id: await videoId("reports-reason"), reason: "" }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { target_type: "source", target_id: await videoId("reports-reason"), reason: "   " }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { target_type: "source", target_id: await videoId("reports-reason"), reason: "x".repeat(1001) }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
      { body: { target_type: "source", target_id: await videoId("reports-reason") }, message: "reason must be a non-empty string", details: { maxLength: 1000 } },
    ];
    for (const { body, message, details } of cases) {
      const result = await client.post("/reports", body);
      expect(result.status).toBe(422);
      expect(result.json).toEqual({ error: { code: "VALIDATION_ERROR", message, details } });
    }
    // A non-object body is 422 too.
    const arrayBody = await client.request("POST", "/reports", {
      rawBody: JSON.stringify([]),
      headers: { "Content-Type": "application/json" },
    });
    expect(arrayBody.status).toBe(422);
    expect(arrayBody.json).toEqual({
      error: { code: "VALIDATION_ERROR", message: "body must be a JSON object", details: {} },
    });
  });

  test("success is 201 {id} with the row stored; no existence check; UUIDs stored lowercased", async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    // A source id that does not exist still reports 201.
    const sourceId = await videoId(`reports-missing-${userId}`);
    const result = await client.post("/reports", {
      target_type: "source",
      target_id: sourceId,
      reason: "  this footage is mislabeled  ",
    });
    expect(result.status).toBe(201);
    expect(typeof result.body.id).toBe("string");
    const row = await stack.db.one<{ reporter_user_id: string; target_type: string; target_id: string; reason: string; status: string }>(
      `SELECT reporter_user_id, target_type, target_id, reason, status FROM reports WHERE id = $1`,
      [result.body.id as string],
    );
    expect(row).toEqual({
      reporter_user_id: userId,
      target_type: "source",
      target_id: sourceId,
      reason: "this footage is mislabeled",
      status: "open",
    });
    // An uppercase UUID is stored lowercased.
    const clipId = crypto.randomUUID().toUpperCase();
    const clipReport = await client.post("/reports", { target_type: "clip", target_id: clipId, reason: "bad clip" });
    expect(clipReport.status).toBe(201);
    const clipRow = await stack.db.one<{ target_id: string }>(`SELECT target_id FROM reports WHERE id = $1`, [clipReport.body.id as string]);
    expect(clipRow?.target_id).toBe(clipId.toLowerCase());
  });

  test("reporting an existing source, clip, and label all work", async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    const sourceId = await videoId(`reports-existing-${userId}`);
    await seedSource(stack, sourceId, { userId, canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }) });
    const clipId = await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
    const labelRow = await stack.db.one<{ id: string }>(`SELECT id FROM labels WHERE clip_id = $1`, [clipId]);
    for (const [target_type, target_id] of [
      ["source", sourceId],
      ["clip", clipId],
      ["label", labelRow!.id],
    ] as const) {
      const result = await client.post("/reports", { target_type, target_id, reason: "bad" });
      expect(result.status).toBe(201);
    }
  });
});
