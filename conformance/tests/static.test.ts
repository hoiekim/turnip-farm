import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness/stack";

describe("static", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());

  test("GET / serves index.html", async () => {
    const result = await stack.anonymous().get("//");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/html");
    expect(result.text).toContain('<div id="root">');
  });

  test("GET /admin serves the SPA shell", async () => {
    const result = await stack.anonymous().get("//admin");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/html");
    expect(result.text).toContain('<div id="root">');
  });

  test("a built asset path serves the file with a detected content type", async () => {
    const index = await stack.anonymous().get("//");
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.text)?.[1];
    expect(asset).toBeTruthy();
    const result = await stack.anonymous().get(`//${asset!.slice(1)}`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("javascript");
    expect(result.text.length).toBeGreaterThan(1000);
  });

  /**
   * A raw request line, bypassing fetch's URL normalization: fetch turns
   * `/../package.json` into `/package.json` before it hits the wire, so
   * the escape paths below can only be tested with the bytes as written.
   */
  const rawGet = async (path: string): Promise<{ status: number; body: string }> => {
    const { port } = new URL(stack.anonymous().origin);
    const socket = connect({ host: "127.0.0.1", port: Number(port) });
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) => socket.on("end", resolve));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    await done;
    const text = Buffer.concat(chunks).toString("utf8");
    return { status: Number(text.split(" ")[1]), body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n") };
  };

  test("dot-segment escapes are normalized by the HTTP layer and fall through to the SPA shell", async () => {
    // Bun normalizes `..` (and `%2e%2e`) in the request target before the
    // handler sees it, so these answer exactly like /package.json: the SPA
    // shell, never the file. The Rust target must reproduce this.
    const shell = await rawGet("/package.json");
    expect(shell.status).toBe(200);
    for (const path of ["/../package.json", "/%2e%2e/package.json"]) {
      const result = await rawGet(path);
      expect(result.status).toBe(200);
      expect(result.body).toBe(shell.body);
      expect(result.body).not.toContain("turnip-farm");
    }
  });

  test("encoded-slash and NUL escapes answer 404, never a file outside build/client", async () => {
    for (const path of ["/..%2fpackage.json", "/..%00/package.json", "/..%2f..%2fpackage.json"]) {
      const result = await rawGet(path);
      expect(result.status).toBe(404);
      expect(result.body).not.toContain("turnip-farm");
    }
  });

  test("/api/* and /auth/* never fall through to the client", async () => {
    for (const path of ["//api/admin", "//auth/login"]) {
      const result = await stack.anonymous().get(path);
      expect(result.status).toBe(404);
      expect(result.json).toEqual({ error: { code: "NOT_FOUND", message: "Not found", details: {} } });
    }
  });
});
