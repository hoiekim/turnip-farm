import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, randomSub } from "../harness/apple";
import { candidateHash, seedSession } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";

describe("labels", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());

  const setup = async (withConsent = true) => {
    const { client, userId } = await seedSession(stack, randomSub());
    if (withConsent) await consented(client);
    return { client, userId };
  };

  describe("POST /api/labels/candidates", () => {
    test("401 anonymous, 403 blocked; consent is NOT required", async () => {
      const anon = await stack.anonymous().post("/labels/candidates", { names: ["raiz"] });
      expect(anon.status).toBe(401);
      const blockedSub = randomSub();
      const { client: blockedClient } = await seedSession(stack, blockedSub, { isBlocked: true });
      const blocked = await blockedClient.post("/labels/candidates", { names: ["raiz"] });
      expect(blocked.status).toBe(403);
      const unconsented = await setup(false);
      const ok = await unconsented.client.post("/labels/candidates", { names: ["raiz"] });
      expect(ok.status).toBe(202);
      expect(ok.text).toBe("");
    });

    test("validation: names must be an array of 1 to 20 strings", async () => {
      const { client } = await setup();
      for (const names of [undefined, null, "raiz", [], Array.from({ length: 21 }, (_, i) => `name-${i}`)]) {
        const result = await client.post("/labels/candidates", { names });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: {
            code: "VALIDATION_ERROR",
            message: "names must be an array of 1 to 20 strings",
            details: { field: "names" },
          },
        });
      }
    });

    test("validation: each name must be a non-empty string of at most 64 characters, with details {field, index}", async () => {
      const { client } = await setup();
      const cases: { names: unknown[]; index: number }[] = [
        { names: [42], index: 0 },
        { names: ["raiz", ""], index: 1 },
        { names: ["raiz", "   "], index: 1 },
        { names: ["raiz", "x".repeat(65)], index: 1 },
        { names: [null], index: 0 },
      ];
      for (const { names, index } of cases) {
        const result = await client.post("/labels/candidates", { names });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: {
            code: "VALIDATION_ERROR",
            message: `names[${index}] must be a non-empty string of at most 64 characters`,
            details: { field: "names", index },
          },
        });
      }
      // Exactly 20 names of exactly 64 characters pass.
      const ok = await client.post("/labels/candidates", {
        names: Array.from({ length: 20 }, (_, i) => `n${i}`.padEnd(64, "x")),
      });
      expect(ok.status).toBe(202);
    });

    test("names are stored trimmed with whitespace collapsed; vocabulary names are skipped", async () => {
      const { client, userId } = await setup();
      const hash = await candidateHash(userId);
      const result = await client.post("/labels/candidates", {
        names: ["  raiz   flip  ", "cork", "  CORK  ", "gainer"],
      });
      expect(result.status).toBe(202);
      const rows = await stack.db.query<{ name: string; account_hash: string }>(
        `SELECT name, account_hash FROM label_candidates WHERE account_hash = $1 ORDER BY name`,
        [hash],
      );
      expect(rows).toEqual([{ name: "raiz flip", account_hash: hash }]);
    });

    test("the same name from the same account is one row; from two accounts it is two", async () => {
      const first = await setup();
      const second = await setup();
      expect((await first.client.post("/labels/candidates", { names: ["raiz"] })).status).toBe(202);
      expect((await first.client.post("/labels/candidates", { names: ["RAIZ"] })).status).toBe(202);
      expect((await second.client.post("/labels/candidates", { names: ["raiz"] })).status).toBe(202);
      const rows = await stack.db.query<{ name: string; account_hash: string }>(
        `SELECT name, account_hash FROM label_candidates WHERE lower(name) = 'raiz' AND account_hash = ANY($1::text[]) ORDER BY account_hash`,
        [[await candidateHash(first.userId), await candidateHash(second.userId)]],
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.account_hash).sort()).toEqual(
        [await candidateHash(first.userId), await candidateHash(second.userId)].sort(),
      );
    });
  });

  describe("POST /api/labels/synonyms", () => {
    test("401 anonymous, 403 blocked; consent is NOT required", async () => {
      const anon = await stack.anonymous().post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      });
      expect(anon.status).toBe(401);
      const blockedSub = randomSub();
      const { client: blockedClient } = await seedSession(stack, blockedSub, { isBlocked: true });
      const blocked = await blockedClient.post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      });
      expect(blocked.status).toBe(403);
      const unconsented = await setup(false);
      const ok = await unconsented.client.post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      });
      expect(ok.status).toBe(202);
      expect(ok.text).toBe("");
    });

    test("validation: synonyms must be an array of 1 to 20 {name, same_as} objects", async () => {
      const { client } = await setup();
      const pair = { name: "a", same_as: "b" };
      for (const synonyms of [
        undefined, null, "nope", [],
        Array.from({ length: 21 }, () => ({ ...pair })),
      ]) {
        const result = await client.post("/labels/synonyms", { synonyms });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: {
            code: "VALIDATION_ERROR",
            message: "synonyms must be an array of 1 to 20 {name, same_as} objects",
            details: { field: "synonyms" },
          },
        });
      }
    });

    test("validation: each pair must have two different names of 1 to 64 characters", async () => {
      const { client } = await setup();
      const cases: { synonyms: unknown[]; index: number }[] = [
        { synonyms: [{ name: 42, same_as: "b" }], index: 0 },
        { synonyms: [{ name: "a" }], index: 0 },
        { synonyms: [{ name: "", same_as: "b" }], index: 0 },
        { synonyms: [{ name: "a", same_as: "x".repeat(65) }], index: 0 },
        { synonyms: [{ name: "cork", same_as: "CORK" }], index: 0 },
        { synonyms: [{ name: "cork ", same_as: " cork" }], index: 0 },
        { synonyms: [{ name: "a", same_as: "b" }, { name: "x", same_as: "x" }], index: 1 },
      ];
      for (const { synonyms, index } of cases) {
        const result = await client.post("/labels/synonyms", { synonyms });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: {
            code: "VALIDATION_ERROR",
            message: `synonyms[${index}] must have two different names of 1 to 64 characters`,
            details: { field: "synonyms", index },
          },
        });
      }
    });

    test("a pair the vocabulary already resolves to one trick is skipped", async () => {
      const { client, userId } = await setup();
      const hash = await candidateHash(userId);
      // cork and corkscrew both resolve to the cork trick at v1.
      const result = await client.post("/labels/synonyms", {
        synonyms: [{ name: "cork", same_as: "corkscrew" }],
      });
      expect(result.status).toBe(202);
      expect(await stack.db.query(`SELECT 1 FROM synonym_candidates WHERE account_hash = $1`, [hash])).toHaveLength(0);
    });

    test("direction matters: a→b and b→a are two rows; the same pair twice is one", async () => {
      const first = await setup();
      const second = await setup();
      const hash1 = await candidateHash(first.userId);
      const hash2 = await candidateHash(second.userId);
      expect((await first.client.post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      })).status).toBe(202);
      expect((await first.client.post("/labels/synonyms", {
        synonyms: [{ name: "cartfull", same_as: "cartwheel full twist" }],
      })).status).toBe(202);
      expect((await first.client.post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      })).status).toBe(202);
      expect((await second.client.post("/labels/synonyms", {
        synonyms: [{ name: "cartwheel full twist", same_as: "cartfull" }],
      })).status).toBe(202);
      const rows = await stack.db.query<{ name: string; same_as: string; account_hash: string }>(
        `SELECT name, same_as, account_hash FROM synonym_candidates WHERE account_hash = ANY($1::text[])`,
        [[hash1, hash2]],
      );
      const byKey = (r: { name: string; same_as: string; account_hash: string }) => `${r.name}|${r.same_as}|${r.account_hash}`;
      expect([...rows].sort((a, b) => (byKey(a) < byKey(b) ? -1 : 1))).toEqual(
        [
          { name: "cartfull", same_as: "cartwheel full twist", account_hash: hash1 },
          { name: "cartwheel full twist", same_as: "cartfull", account_hash: hash1 },
          { name: "cartwheel full twist", same_as: "cartfull", account_hash: hash2 },
        ].sort((a, b) => (byKey(a) < byKey(b) ? -1 : 1)),
      );
    });
  });
});
