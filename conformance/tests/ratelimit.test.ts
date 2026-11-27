import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedAdminSession } from "../harness/admin";
import { consented, nextAddress, randomSub, signIn, sourceKey, videoId } from "../harness/apple";
import { startStack, type Stack } from "../harness/stack";

describe("rate limits", () => {
  let stack: Stack;
  let adminStack: Stack;
  beforeAll(async () => {
    stack = await startStack({});
    adminStack = await startStack({ admin: true });
  });
  afterAll(async () => {
    await stack?.stop();
    await adminStack?.stop();
  });

  const rateLimited = (result: { status: number; json: unknown; headers: Headers }) => {
    expect(result.status).toBe(429);
    expect(result.json).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests", details: {} },
    });
    const retryAfter = Number(result.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  };

  test("per-user 60/min is shared across consent, reports, and sources; another user is unaffected", async () => {
    const { client, userId } = await signIn(stack, randomSub());
    await consented(client);
    // POST /api/consent already took one token, so 59 reports fill the
    // bucket; the 60th contribution is the one that is refused.
    for (let i = 0; i < 59; i++) {
      const report = await client.post("/reports", {
        target_type: "source",
        target_id: await videoId(`ratelimit-report-${i}-${userId}`),
        reason: "spam",
      });
      expect(report.status).toBe(201);
    }
    const refused = await client.post("/sources", {
      video_id: await videoId(`ratelimit-source-${userId}`),
      source_key: sourceKey(),
      frame_count: 10,
      sample_rate: 10,
      keypoint_format: "tkp1",
      storefront_country: "USA",
    });
    rateLimited(refused);
    // A different user has their own bucket.
    const other = await signIn(stack, randomSub());
    await consented(other.client);
    const ok = await other.client.post("/reports", {
      target_type: "source",
      target_id: await videoId(`ratelimit-other-${other.userId}`),
      reason: "spam",
    });
    expect(ok.status).toBe(201);
  });

  test("sign-in and notifications share the 10/min IP bucket; another IP is unaffected", async () => {
    const address = nextAddress();
    const notify = async () => {
      const payload = await stack.upstream.apple.notificationPayload({
        claims: { events: { type: "consent-revoked", sub: randomSub() } },
      });
      return stack.anonymous().post("/auth/apple/notifications", { payload }, { headers: { "X-Forwarded-For": address } });
    };
    for (let i = 0; i < 5; i++) await signIn(stack, randomSub(), { forwardedFor: address });
    for (let i = 0; i < 5; i++) expect((await notify()).status).toBe(200);
    rateLimited(await notify());
    expect((await notify()).status).toBe(429);
    // Another IP has its own bucket.
    const elsewhere = await stack.anonymous().post(
      "/auth/apple/notifications",
      { payload: await stack.upstream.apple.notificationPayload({ claims: { events: { type: "consent-revoked", sub: randomSub() } } }) },
      { headers: { "X-Forwarded-For": nextAddress() } },
    );
    expect(elsewhere.status).toBe(200);
  });

  test("public GETs share the 30/min IP bucket across taxonomy, stats, and models", async () => {
    const address = nextAddress();
    const get = (path: string) => stack.anonymous().get(path, { headers: { "X-Forwarded-For": address } });
    for (let i = 0; i < 15; i++) expect((await get("//api/taxonomy/current")).status).toBe(200);
    for (let i = 0; i < 15; i++) expect((await get("//api/stats")).status).toBe(200);
    rateLimited(await get("//api/models/current"));
    expect((await get("//api/taxonomy/current")).status).toBe(429);
    // Another IP has its own bucket.
    const elsewhere = await stack.anonymous().get("//api/taxonomy/current", { headers: { "X-Forwarded-For": nextAddress() } });
    expect(elsewhere.status).toBe(200);
  });

  test("admin 60/min per IP refuses the 61st, then a token refills within a few seconds", async () => {
    const { client } = await seedAdminSession(adminStack, {});
    const address = nextAddress();
    const get = () => client.get("//api/admin/sources", { headers: { "X-Forwarded-For": address } });
    for (let i = 0; i < 60; i++) expect((await get()).status).toBe(200);
    rateLimited(await get());
    // The bucket refills one token a second; the next GET that succeeds
    // proves the refill rather than a fixed sleep.
    const refilled = await adminStack.waitFor(async () => {
      const result = await get();
      return result.status === 200 ? result : null;
    }, { timeoutMs: 5000, what: "an admin token to refill" });
    expect(refilled?.status).toBe(200);
  });
});
