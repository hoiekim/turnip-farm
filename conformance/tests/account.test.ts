import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, randomSub, signIn, videoId } from "../harness/apple";
import { candidateHash, seedClip, seedConsent, seedSource, seedStagedBlob } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1 } from "../harness/tkp1";

describe("account", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack.stop());

  /** Seeds a full account through the API + SQL, the way the unit-test helper does. */
  const seedAccount = async (sub: string) => {
    const { client } = await signIn(stack, sub);
    await consented(client);
    const sourceId = await videoId(`account-${sub}`);
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, { userId: sub, canonicalBytes: staged });
    await seedStagedBlob(stack, sourceId, staged);
    const clipId = await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
    // A label candidate, a synonym candidate, and a report, as the account leaves them.
    const hash = await candidateHash(sub);
    await stack.db.query(`INSERT INTO label_candidates (name, account_hash) VALUES ('raiz', $1)`, [hash]);
    await stack.db.query(
      `INSERT INTO synonym_candidates (name, same_as, account_hash) VALUES ('cartwheel full twist', 'cartfull', $1)`,
      [hash],
    );
    await stack.db.query(
      `INSERT INTO reports (reporter_user_id, target_type, target_id, reason) VALUES ($1, 'source', $2, 'test report')`,
      [sub, sourceId],
    );
    return { client, sourceId, clipId };
  };

  const remains = async (userId: string, sourceIds: string[]) => {
    const ids = `{${sourceIds.join(",")}}`;
    const hash = await candidateHash(userId);
    const [row] = await stack.db.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM users WHERE id = $1)::int AS users,
              (SELECT count(*) FROM sessions WHERE user_id = $1)::int AS sessions,
              (SELECT count(*) FROM users WHERE id = $1 AND apple_refresh_token IS NOT NULL)::int AS apple_tokens,
              (SELECT count(*) FROM consents WHERE user_id = $1)::int AS consents,
              (SELECT count(*) FROM source_attribution WHERE user_id = $1)::int AS attribution,
              (SELECT count(*) FROM sources WHERE id = ANY($2::char(64)[]))::int AS sources,
              (SELECT count(*) FROM clips WHERE source_id = ANY($2::char(64)[]))::int AS clips,
              (SELECT count(*) FROM labels l JOIN clips c ON c.id = l.clip_id WHERE c.source_id = ANY($2::char(64)[]))::int AS labels,
              (SELECT count(*) FROM label_candidates WHERE account_hash = $3)::int AS label_candidates,
              (SELECT count(*) FROM synonym_candidates WHERE account_hash = $3)::int AS synonym_candidates,
              (SELECT count(*) FROM reports WHERE reporter_user_id = $1)::int AS reports`,
      [userId, ids, hash],
    );
    return row!;
  };

  test("401 with no token and with an expired token", async () => {
    const noToken = await stack.anonymous().delete("/account");
    expect(noToken.status).toBe(401);
    const expired = randomSub();
    await stack.db.query(`INSERT INTO users (id) VALUES ($1)`, [expired]);
    await stack.db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 hour')`,
      [expired, "1".repeat(64)],
    );
    const result = await stack.anonymous().withBearer("B".repeat(43)).delete("/account");
    expect(result.status).toBe(401);
  });

  test("a blocked user may still delete their account", async () => {
    const sub = randomSub();
    const { client } = await signIn(stack, sub);
    await stack.db.query(`UPDATE users SET is_blocked = true WHERE id = $1`, [sub]);
    const result = await client.delete("/account");
    expect(result.status).toBe(204);
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [sub]);
    expect(user).toBeUndefined();
  });

  test("success deletes everything and revokes the Apple refresh token exactly once", async () => {
    const sub = randomSub();
    const { client, sourceId } = await seedAccount(sub);
    const revokeBefore = stack.upstream.apple.revokeRequests.length;
    const result = await client.delete("/account");
    expect(result.status).toBe(204);
    expect(await remains(sub, [sourceId])).toEqual({
      users: 0, sessions: 0, apple_tokens: 0, consents: 0, attribution: 0,
      sources: 0, clips: 0, labels: 0, label_candidates: 0, synonym_candidates: 0, reports: 0,
    });
    expect(stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)).toBeUndefined();
    expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeUndefined();
    const revokes = stack.upstream.apple.revokeRequests.slice(revokeBefore);
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.get("token")).toBe(stack.upstream.apple.refreshTokenFor(sub)!);
    expect(revokes[0]!.get("token_type_hint")).toBe("refresh_token");
  });

  test("an Apple revoke 5xx is 503 with nothing deleted; a retry then succeeds", async () => {
    const sub = randomSub();
    const { client, sourceId } = await seedAccount(sub);
    const restore = stack.upstream.apple.state.revoke;
    stack.upstream.apple.state.revoke = () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
    try {
      const result = await client.delete("/account");
      expect(result.status).toBe(503);
      expect(result.json).toEqual({
        error: { code: "APPLE_UNAVAILABLE", message: "Apple is unreachable; retry later", details: {} },
      });
    } finally {
      stack.upstream.apple.state.revoke = restore;
    }
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [sub]);
    expect(user).toBeDefined();
    const retry = await client.delete("/account");
    expect(retry.status).toBe(204);
    expect(await remains(sub, [sourceId])).toEqual({
      users: 0, sessions: 0, apple_tokens: 0, consents: 0, attribution: 0,
      sources: 0, clips: 0, labels: 0, label_candidates: 0, synonym_candidates: 0, reports: 0,
    });
  });

  test("an Apple revoke 400 deletes anyway", async () => {
    const sub = randomSub();
    const { client, sourceId } = await seedAccount(sub);
    const restore = stack.upstream.apple.state.revoke;
    stack.upstream.apple.state.revoke = () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
    try {
      const result = await client.delete("/account");
      expect(result.status).toBe(204);
    } finally {
      stack.upstream.apple.state.revoke = restore;
    }
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [sub]);
    expect(user).toBeUndefined();
    expect(await remains(sub, [sourceId])).toEqual({
      users: 0, sessions: 0, apple_tokens: 0, consents: 0, attribution: 0,
      sources: 0, clips: 0, labels: 0, label_candidates: 0, synonym_candidates: 0, reports: 0,
    });
  });

  test("an R2 delete failure is 500 with the rows surviving; a retry succeeds", async () => {
    const sub = randomSub();
    const { client, sourceId } = await seedAccount(sub);
    stack.upstream.r2.failNext("DELETE", 500);
    const result = await client.delete("/account");
    expect(result.status).toBe(500);
    expect(result.json).toEqual({
      error: { code: "INTERNAL", message: "Could not delete the stored blobs; retry later", details: {} },
    });
    const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [sub]);
    expect(user).toBeDefined();
    const retry = await client.delete("/account");
    expect(retry.status).toBe(204);
  });

  test("retry after success is 401 (the session is gone)", async () => {
    const sub = randomSub();
    const { client } = await seedAccount(sub);
    expect((await client.delete("/account")).status).toBe(204);
    const retry = await client.delete("/account");
    expect(retry.status).toBe(401);
  });

  test("?contributions=keep and ?contributions=delete both mean the full deletion", async () => {
    for (const query of ["?contributions=keep", "?contributions=delete"]) {
      const sub = randomSub();
      const { client, sourceId } = await seedAccount(sub);
      const result = await client.delete(`/account${query}`);
      expect(result.status).toBe(204);
      const user = await stack.db.one(`SELECT id FROM users WHERE id = $1`, [sub]);
      expect(user).toBeUndefined();
      expect(await remains(sub, [sourceId])).toEqual({
        users: 0, sessions: 0, apple_tokens: 0, consents: 0, attribution: 0,
        sources: 0, clips: 0, labels: 0, label_candidates: 0, synonym_candidates: 0, reports: 0,
      });
    }
  });
});
