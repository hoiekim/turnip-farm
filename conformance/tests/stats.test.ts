import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomSub, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedSession, seedSource } from "../harness/seed/contrib";
import { seedQuarantine } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1 } from "../harness/tkp1";

describe("stats", () => {
  // Totals accumulate across the whole database, so each test gets a
  // fresh stack.
  let stack: Stack;
  beforeEach(async () => {
    stack = await startStack();
  });
  afterEach(() => stack.stop());

  /** Seeds `n` users, each with one source + one clip + one label, today. */
  const seedCommunity = async (n: number, options: { quarantineOne?: boolean } = {}) => {
    const sourceIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const { userId } = await seedSession(stack, randomSub());
      const sourceId = await videoId(`stats-${userId}`);
      await seedSource(stack, sourceId, {
        userId,
        sourceKey: sourceKey(),
        canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }),
      });
      await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
      sourceIds.push(sourceId);
    }
    if (options.quarantineOne) {
      await seedQuarantine(stack, sourceIds[0]!, { reason: "stats check" });
    }
    return sourceIds;
  };

  test("an empty farm reports zeros and ninety zero days", async () => {
    const result = await stack.anonymous().get("/stats");
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("max-age=60");
    expect(result.headers.get("etag")).toBeNull();
    const todayUtc = new Date().toISOString().slice(0, 10);
    const body = result.body as {
      totals: { users: number; sources: number; clips: number; labels: number };
      users_by_day: { date: string; count: number }[];
      labels_by_day: { date: string; count: number }[];
    };
    expect(body.totals).toEqual({ users: 0, sources: 0, clips: 0, labels: 0 });
    expect(body.users_by_day).toHaveLength(90);
    expect(body.labels_by_day).toHaveLength(90);
    for (const series of [body.users_by_day, body.labels_by_day]) {
      expect(series[89]!.date).toBe(todayUtc);
      expect(series[89]!.count).toBe(0);
      // The series is continuous, one day per entry, ascending.
      const first = new Date(`${series[0]!.date}T00:00:00Z`).getTime();
      for (let i = 0; i < 90; i++) {
        expect(new Date(`${series[i]!.date}T00:00:00Z`).getTime()).toBe(first + i * 86400 * 1000);
        expect(series[i]!.count).toBe(0);
      }
    }
  });

  test("counts round down to a multiple of 5", async () => {
    await seedCommunity(3);
    const result = await stack.anonymous().get("/stats");
    const body = result.body as { totals: { users: number; sources: number; clips: number; labels: number } };
    // 3 users, 3 sources, 3 clips, 3 labels — each reads 0.
    expect(body.totals).toEqual({ users: 0, sources: 0, clips: 0, labels: 0 });
    await seedCommunity(7);
    const result2 = await stack.anonymous().get("/stats");
    const body2 = result2.body as { totals: { users: number; sources: number; clips: number; labels: number } };
    // 10 of each now: 10 reads 10.
    expect(body2.totals).toEqual({ users: 10, sources: 10, clips: 10, labels: 10 });
  });

  test("the daily series buckets by UTC day and covers only the last 90 days", async () => {
    await seedCommunity(6);
    // One user from 100 days ago: inside the totals, outside the series.
    const { userId: oldUser } = await seedSession(stack, randomSub());
    await stack.db.query(`UPDATE users SET created_at = now() - interval '100 days' WHERE id = $1`, [oldUser]);
    const result = await stack.anonymous().get("/stats");
    const body = result.body as {
      totals: { users: number };
      users_by_day: { date: string; count: number }[];
      labels_by_day: { date: string; count: number }[];
    };
    expect(body.totals.users).toBe(5); // 7 users total, rounded down.
    const today = body.users_by_day[89]!;
    expect(today.count).toBe(5); // 6 signups today.
    expect(body.users_by_day.slice(0, 89).every((d) => d.count === 0)).toBe(true);
    expect(body.labels_by_day[89]!.count).toBe(5); // 6 labels today.
  });

  test("quarantined rows still count: this is community activity, not the training set", async () => {
    await seedCommunity(10, { quarantineOne: true });
    const result = await stack.anonymous().get("/stats");
    const body = result.body as { totals: { users: number; sources: number; clips: number; labels: number } };
    expect(body.totals).toEqual({ users: 10, sources: 10, clips: 10, labels: 10 });
  });
});
