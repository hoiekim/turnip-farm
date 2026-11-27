import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomSub } from "../harness/apple";
import { seedSession } from "../harness/seed/contrib";
import { seedTaxonomyRow } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";

describe("taxonomy", () => {
  // Each test gets a fresh stack: the vocabulary is global, and the v2
  // tests seed rows that would change every later test's answer.
  let stack: Stack;
  beforeEach(async () => {
    stack = await startStack();
  });
  afterEach(() => stack?.stop());

  test("public: the v1 vocabulary, with ETag and Cache-Control", async () => {
    const result = await stack.anonymous().get("/taxonomy/current");
    expect(result.status).toBe(200);
    expect(result.headers.get("etag")).toBe('"1"');
    expect(result.headers.get("cache-control")).toBe("max-age=3600");
    expect(result.body).toEqual({
      taxonomy_version: 1,
      vocabulary: [
        { canonical: "cartfull", aliases: ["cartfull"] },
        { canonical: "cork", aliases: ["cork", "corkscrew"] },
        { canonical: "gainer", aliases: ["gainer"] },
        { canonical: "hook", aliases: ["hook"] },
        { canonical: "scoot", aliases: ["scoot"] },
      ],
    });
  });

  test("a session-bearing request works the same way (not tied to an account)", async () => {
    const { client } = await seedSession(stack, randomSub());
    const result = await client.get("/taxonomy/current");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      taxonomy_version: 1,
      vocabulary: [
        { canonical: "cartfull", aliases: ["cartfull"] },
        { canonical: "cork", aliases: ["cork", "corkscrew"] },
        { canonical: "gainer", aliases: ["gainer"] },
        { canonical: "hook", aliases: ["hook"] },
        { canonical: "scoot", aliases: ["scoot"] },
      ],
    });
  });

  test("a v2 row adds a canonical and bumps the version", async () => {
    await seedTaxonomyRow(stack, "raiz", "raiz flip", 2);
    const result = await stack.anonymous().get("/taxonomy/current");
    expect(result.status).toBe(200);
    expect(result.headers.get("etag")).toBe('"2"');
    expect(result.body).toEqual({
      taxonomy_version: 2,
      vocabulary: [
        { canonical: "cartfull", aliases: ["cartfull"] },
        { canonical: "cork", aliases: ["cork", "corkscrew"] },
        { canonical: "gainer", aliases: ["gainer"] },
        { canonical: "hook", aliases: ["hook"] },
        { canonical: "raiz flip", aliases: ["raiz"] },
        { canonical: "scoot", aliases: ["scoot"] },
      ],
    });
  });

  test("a v2 rename re-points the raw to the new canonical", async () => {
    await seedTaxonomyRow(stack, "corkscrew", "corkflip", 2);
    const result = await stack.anonymous().get("/taxonomy/current");
    expect(result.body).toEqual({
      taxonomy_version: 2,
      vocabulary: [
        { canonical: "cartfull", aliases: ["cartfull"] },
        { canonical: "cork", aliases: ["cork"] },
        { canonical: "corkflip", aliases: ["corkscrew"] },
        { canonical: "gainer", aliases: ["gainer"] },
        { canonical: "hook", aliases: ["hook"] },
        { canonical: "scoot", aliases: ["scoot"] },
      ],
    });
  });
});
