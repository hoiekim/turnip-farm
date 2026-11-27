import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness/stack";

describe("http", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({});
  });
  afterAll(() => stack.stop());

  test("a body over 1 MiB on a 1 MiB route is Bun's bare 413: empty body, connection closed", async () => {
    // Bun.serve's maxRequestBodySize is the largest route cap (1 MiB), so
    // the body never reaches the handler's own cap: the answer is a bare
    // 413, not the route's 422 BodyTooLargeError. Probed against Bun.serve
    // directly: status 413, an empty body, and `connection: close`.
    for (const path of ["/clips", "/quarantine"]) {
      const result = await stack.anonymous().request("POST", path, {
        rawBody: "x".repeat(1024 * 1024 + 1),
        headers: { "Content-Type": "application/json" },
      });
      expect(result.status).toBe(413);
      expect(result.text).toBe("");
      expect(result.headers.get("connection")).toBe("close");
    }
  });

  test("exactly 1 MiB reaches the handler: without auth it is 401, not 413", async () => {
    const result = await stack.anonymous().request("POST", "/clips", {
      rawBody: "x".repeat(1024 * 1024),
      headers: { "Content-Type": "application/json" },
    });
    expect(result.status).toBe(401);
  });

  test("HEAD on a GET route is 404: the router matches the method exactly", async () => {
    // Bun.serve does not synthesize a HEAD answer from a GET route: the
    // farm's router sees a method it has no route for and answers 404.
    const res = await fetch(`${stack.anonymous().origin}/healthz`, { method: "HEAD" });
    expect(res.status).toBe(404);
  });

  test("a wrong method on a known path is 404 in the API error shape", async () => {
    for (const [method, path] of [
      ["DELETE", "/api/taxonomy/current"],
      ["PUT", "/api/stats"],
      ["PATCH", "/api/models/current"],
    ] as const) {
      const result = await stack.anonymous().request(method, path);
      expect(result.status).toBe(404);
      expect(result.json).toEqual({
        error: { code: "NOT_FOUND", message: "Not found", details: {} },
      });
    }
  });
});
