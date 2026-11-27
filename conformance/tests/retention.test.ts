import { describe, expect, test } from "bun:test";
import { randomSub, signIn } from "../harness/apple";
import { candidateHash, seedSession, seedSource } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";
import { videoId } from "../harness/apple";

describe("retention", () => {
  const count = async (stack: Stack, table: string, where = "") =>
    (await stack.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} ${where}`))?.n ?? 0;

  test("reports older than 30 days are purged at startup; fresh ones survive", async () => {
    const userId = randomSub();
    const stack = await startStack({
      beforeStart: async (s) => {
        await s.db.query(`INSERT INTO users (id) VALUES ($1)`, [userId]);
        await s.db.query(
          `INSERT INTO reports (reporter_user_id, target_type, target_id, reason, created_at) VALUES
             ($1, 'source', $2, 'old', now() - interval '31 days'),
             ($1, 'source', $2, 'fresh', now() - interval '1 day')`,
          [userId, await videoId(`retention-report-${userId}`)],
        );
      },
    });
    try {
      expect(await count(stack, "reports")).toBe(1);
      const remaining = await stack.db.one<{ reason: string }>(`SELECT reason FROM reports`);
      expect(remaining?.reason).toBe("fresh");
    } finally {
      await stack.stop();
    }
  });

  test("label and synonym candidates older than 30 days are purged at startup", async () => {
    const hash = await candidateHash("retention-candidate-user");
    const stack = await startStack({
      beforeStart: async (s) => {
        await s.db.query(
          `INSERT INTO label_candidates (name, account_hash, submitted_at) VALUES
             ('old-trick', $1, now() - interval '31 days'),
             ('fresh-trick', $1, now() - interval '1 day')`,
          [hash],
        );
        await s.db.query(
          `INSERT INTO synonym_candidates (name, same_as, account_hash, submitted_at) VALUES
             ('old-name', 'old-alias', $1, now() - interval '31 days'),
             ('fresh-name', 'fresh-alias', $1, now() - interval '1 day')`,
          [hash],
        );
      },
    });
    try {
      expect(await count(stack, "label_candidates")).toBe(1);
      expect(await count(stack, "synonym_candidates")).toBe(1);
      expect((await stack.db.one<{ name: string }>(`SELECT name FROM label_candidates`))?.name).toBe("fresh-trick");
    } finally {
      await stack.stop();
    }
  });

  test("attribution older than 30 days is purged only for accounts that never agreed to disclosure 3+", async () => {
    const noConsent = randomSub();
    const consented = randomSub();
    const stack = await startStack({
      beforeStart: async (s) => {
        const first = await seedSession(s, noConsent);
        const second = await seedSession(s, consented);
        const one = await seedSource(s, await videoId(`retention-attr-${noConsent}`), { userId: first.userId });
        const two = await seedSource(s, await videoId(`retention-attr-${consented}`), { userId: second.userId });
        await s.db.query(`UPDATE source_attribution SET attributed_at = now() - interval '31 days' WHERE source_id IN ($1, $2)`, [
          one.sourceId,
          two.sourceId,
        ]);
        await s.db.query(`INSERT INTO consents (user_id, disclosure_version) VALUES ($1, 3)`, [consented]);
      },
    });
    try {
      expect(await count(stack, "source_attribution")).toBe(1);
      const kept = await stack.db.one<{ user_id: string }>(`SELECT user_id FROM source_attribution`);
      expect(kept?.user_id).toBe(consented);
    } finally {
      await stack.stop();
    }
  });

  test("stale training-source pages older than a day are purged at startup", async () => {
    const stack = await startStack({
      beforeStart: async (s) => {
        const { userId } = await seedSession(s, randomSub());
        const staleId = await videoId(`retention-page-stale-${userId}`);
        const freshId = await videoId(`retention-page-fresh-${userId}`);
        await seedSource(s, staleId, { userId });
        await seedSource(s, freshId, { userId });
        await s.db.query(
          `INSERT INTO models (version, taxonomy_version, r2_key, sha256) VALUES ('9.9.9', 1, 'models/9.9.9.bin', $1)`,
          ["0".repeat(64)],
        );
        await s.db.query(
          `INSERT INTO model_training_source_pages (model_version, model_sha256, source_id, staged_at) VALUES
             ('9.9.9', $1, $2, now() - interval '25 hours'),
             ('9.9.9', $1, $3, now() - interval '1 hour')`,
          ["0".repeat(64), staleId, freshId],
        );
      },
    });
    try {
      expect(await count(stack, "model_training_source_pages")).toBe(1);
    } finally {
      await stack.stop();
    }
  });

  test("expired admin sessions are purged at startup; live ones survive", async () => {
    const stack = await startStack({
      beforeStart: async (s) => {
        await s.db.query(
          `INSERT INTO admin_sessions (token_hash, auth_sub, auth_sid, username, role, recheck_at, verified_at, expires_at) VALUES
             ($1, 'sub-old', 'sid-old', 'maintainer', 'admin', now(), now(), now() - interval '1 minute'),
             ($2, 'sub-new', 'sid-new', 'maintainer', 'admin', now(), now(), now() + interval '1 hour')`,
          ["a".repeat(64), "b".repeat(64)],
        );
      },
    });
    try {
      expect(await count(stack, "admin_sessions")).toBe(1);
      expect((await stack.db.one<{ auth_sub: string }>(`SELECT auth_sub FROM admin_sessions`))?.auth_sub).toBe("sub-new");
    } finally {
      await stack.stop();
    }
  });

  test("an idle account is deleted with its sources and its Apple refresh token is revoked", async () => {
    const stack = await startStack({});
    try {
      const { userId } = await signIn(stack, randomSub());
      const sub = userId;
      const sourceId = await videoId(`retention-idle-${userId}`);
      await seedSource(stack, sourceId, { userId });
      await stack.db.query(`UPDATE users SET last_active_at = now() - interval '25 months' WHERE id = $1`, [userId]);
      await stack.restart();
      expect(await count(stack, "users", `WHERE id = '${userId}'`)).toBe(0);
      expect(await count(stack, "sources", `WHERE id = '${sourceId}'`)).toBe(0);
      const forms = stack.upstream.apple.revokeForms();
      expect(forms).toHaveLength(1);
      expect(forms[0]!.token).toBe(stack.upstream.apple.refreshTokenFor(sub)!);
      // The line was logged by the restart's startup retention: wait for
      // the first occurrence, not one more (the no-count default).
      await stack.waitForLog("idle accounts: 1 deleted, 0 failed", { count: 1 });
    } finally {
      await stack.stop();
    }
  });

  test("an idle account survives when the Apple revoke fails, and is deleted once it succeeds", async () => {
    const stack = await startStack({});
    try {
      const { userId } = await signIn(stack, randomSub());
      await stack.db.query(`UPDATE users SET last_active_at = now() - interval '25 months' WHERE id = $1`, [userId]);
      stack.upstream.apple.state.revoke = () => new Response(null, { status: 500 });
      await stack.restart();
      expect(await count(stack, "users", `WHERE id = '${userId}'`)).toBe(1);
      // The line was logged by the restart's startup retention, so this
      // waits for the first occurrence — not one more, which is the
      // no-count default (stack.ts waitForLog).
      await stack.waitForLog("idle accounts: 0 deleted, 1 failed", { count: 1 });
      stack.upstream.apple.state.revoke = () => new Response(null, { status: 200 });
      await stack.restart();
      expect(await count(stack, "users", `WHERE id = '${userId}'`)).toBe(0);
    } finally {
      await stack.stop();
    }
  });

  test("an account idle 23 months survives", async () => {
    const stack = await startStack({});
    try {
      const { userId } = await signIn(stack, randomSub());
      await stack.db.query(`UPDATE users SET last_active_at = now() - interval '23 months' WHERE id = $1`, [userId]);
      await stack.restart();
      expect(await count(stack, "users", `WHERE id = '${userId}'`)).toBe(1);
      expect(stack.upstream.apple.revokeForms()).toHaveLength(0);
    } finally {
      await stack.stop();
    }
  });
});
