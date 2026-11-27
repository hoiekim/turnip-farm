import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomSub, signIn } from "../harness/apple";
import { seedSession } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { sha256Hex } from "../harness/tkp1";

describe("auth-signout", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  test("204 with a valid token, and the session row is gone", async () => {
    const { client, token } = await seedSession(stack, randomSub());
    const before = await stack.db.one<{ n: string }>(`SELECT count(*)::int AS n FROM sessions`);
    expect(Number(before?.n)).toBeGreaterThan(0);
    const result = await client.post("/auth/signout");
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    const row = await stack.db.one(
      `SELECT id FROM sessions WHERE token_hash = $1`,
      [await sha256Hex(new TextEncoder().encode(token))],
    );
    expect(row).toBeUndefined();
  });

  test("204 with no token, with an unknown token, and for a blocked user", async () => {
    const noToken = await stack.anonymous().post("/auth/signout");
    expect(noToken.status).toBe(204);
    const unknown = await stack.anonymous().withBearer("A".repeat(43)).post("/auth/signout");
    expect(unknown.status).toBe(204);
    const blocked = randomSub();
    await stack.db.query(`INSERT INTO users (id, is_blocked) VALUES ($1, true)`, [blocked]);
    const { client } = await signIn(stack, blocked);
    const result = await client.post("/auth/signout");
    expect(result.status).toBe(204);
  });

  test("signout deletes only that session; a second session of the same user survives", async () => {
    const userId = randomSub();
    const first = await seedSession(stack, userId);
    const second = await seedSession(stack, userId);
    const result = await first.client.post("/auth/signout");
    expect(result.status).toBe(204);
    // The second session still authenticates.
    const consented = await second.client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(consented.status).toBe(204);
    // The first no longer does.
    const gone = await first.client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(gone.status).toBe(401);
  });
});
