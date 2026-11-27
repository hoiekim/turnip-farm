import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness/stack";

describe("health", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  test("GET /healthz answers {status: ok} with no auth, no cookies, no rate limit", async () => {
    // Hammer it past the public bucket: /healthz is not in any bucket.
    for (let i = 0; i < 35; i++) {
      const result = await stack.anonymous().get("//healthz");
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "ok" });
      expect(result.setCookies).toEqual([]);
    }
  });

  test("unknown /api path answers 404 NOT_FOUND, never the SPA shell", async () => {
    const result = await stack.anonymous().get("//api/nope");
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
  });

  test("wrong method on a known path answers 404 NOT_FOUND", async () => {
    const result = await stack.anonymous().get("/reports");
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
  });

  test("GET / serves the SPA shell", async () => {
    const result = await stack.anonymous().get("//");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/html");
    expect(result.text).toContain("<!DOCTYPE html>");
  });

  test("every error body has exactly {error: {code, message, details}}", async () => {
    const result = await stack.anonymous().get("//api/nope");
    expect(Object.keys(result.json ?? {})).toEqual(["error"]);
    expect(Object.keys(((result.json ?? {}) as { error: object }).error).sort()).toEqual(["code", "details", "message"]);
  });
});
