import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_COOKIE, seedAdminSession } from "../harness/admin";
import { randomSub, sourceKey, videoId } from "../harness/apple";
import { candidateHash, seedClip, seedSession, seedSource } from "../harness/seed/contrib";
import { seedQuarantine } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";
import type { ApiClient } from "../harness/client";

describe("admin sources", () => {
  let stack: Stack;
  let admin: ApiClient;
  let adminToken: string;
  beforeAll(async () => {
    stack = await startStack({ admin: true });
    const seeded = await seedAdminSession(stack, {});
    admin = seeded.client;
    adminToken = seeded.token;
  });
  afterAll(() => stack?.stop());

  const originHeaders = () => ({ Origin: stack.anonymous().origin });

  const setupSource = async (options: {
    holdout?: boolean;
    ingestedAt?: Date | null;
    labels?: { name: string; origin?: string }[];
    createdAt?: Date;
  } = {}) => {
    const { userId } = await seedSession(stack, randomSub());
    const sourceId = await videoId(`admin-sources-${userId}`);
    const key = sourceKey();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, {
      userId,
      sourceKey: key,
      frameCount: 100,
      canonicalBytes: staged,
      holdout: options.holdout ?? false,
      createdAt: options.createdAt,
    });
    if (options.ingestedAt !== undefined) {
      await stack.db.query(`UPDATE sources SET ingested_at = $1 WHERE id = $2`, [options.ingestedAt, sourceId]);
    }
    const clipId = options.labels
      ? await seedClip(stack, sourceId, { startFrame: 0, endFrame: 10, labels: options.labels })
      : undefined;
    return { userId, sourceId, key, staged, clipId };
  };

  describe("GET /api/admin/sources", () => {
    test("401 without a session", async () => {
      const result = await stack.anonymous().get("//api/admin/sources");
      expect(result.status).toBe(401);
    });

    test("holdout and cursor validation", async () => {
      const badHoldout = await admin.get("//api/admin/sources?holdout=yes");
      expect(badHoldout.status).toBe(422);
      expect(badHoldout.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "holdout must be all, true or false", details: { field: "holdout" } },
      });
      const badCursor = await admin.get("//api/admin/sources?cursor=garbage");
      expect(badCursor.status).toBe(422);
      expect(badCursor.json).toEqual({
        error: { code: "VALIDATION_ERROR", message: "cursor must be a next_cursor from a previous page", details: { field: "cursor" } },
      });
    });

    test("row shape: fields, clips with sorted distinct names, ingested and quarantined flags", async () => {
      const ingestedAt = new Date("2026-01-02T03:04:05.123456Z");
      const { sourceId } = await setupSource({
        ingestedAt,
        labels: [
          { name: "gainer", origin: "vocabulary" },
          { name: "cork", origin: "typed" },
        ],
      });
      const quarantined = await setupSource({});
      await seedQuarantine(stack, quarantined.sourceId, { reason: "regression" });
      const un_ingested = await setupSource({});
      await stack.db.query(`UPDATE sources SET sha256 = NULL WHERE id = $1`, [un_ingested.sourceId]);
      const result = await admin.get(`//api/admin/sources?holdout=all`);
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      const sources = result.body.sources as Record<string, unknown>[];
      const row = sources.find((s) => s.id === sourceId)!;
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(row.ingested_at).toBe("2026-01-02T03:04:05.123000Z");
      expect(row.frame_count).toBe(100);
      expect(row.sample_rate).toBe(10);
      expect(row.ingested).toBe(true);
      expect(row.holdout).toBe(false);
      expect(row.quarantined).toBe(false);
      const clips = row.clips as { id: string; start_frame: number; end_frame: number; names: string[] }[];
      expect(clips).toHaveLength(1);
      expect(clips[0]!.names).toEqual(["cork", "gainer"]);
      const quarantinedRow = sources.find((s) => s.id === quarantined.sourceId)!;
      expect(quarantinedRow.quarantined).toBe(true);
      const un_ingestedRow = sources.find((s) => s.id === un_ingested.sourceId)!;
      expect(un_ingestedRow.ingested).toBe(false);
      expect(un_ingestedRow.ingested_at).toBeNull();
    });

    test("holdout filter: true, false, and all", async () => {
      const holdout = await setupSource({ holdout: true });
      const plain = await setupSource({ holdout: false });
      const onlyHoldout = await admin.get("//api/admin/sources?holdout=true");
      const holdoutIds = (onlyHoldout.body.sources as { id: string }[]).map((s) => s.id);
      expect(holdoutIds).toContain(holdout.sourceId);
      expect(holdoutIds).not.toContain(plain.sourceId);
      const onlyPlain = await admin.get("//api/admin/sources?holdout=false");
      const plainIds = (onlyPlain.body.sources as { id: string }[]).map((s) => s.id);
      expect(plainIds).toContain(plain.sourceId);
      expect(plainIds).not.toContain(holdout.sourceId);
      const all = await admin.get("//api/admin/sources?holdout=all");
      const allIds = (all.body.sources as { id: string }[]).map((s) => s.id);
      expect(allIds).toContain(holdout.sourceId);
      expect(allIds).toContain(plain.sourceId);
    });

    test("paging: 51 sources come back 50 + 1, newest first, via next_cursor", async () => {
      // Distinct created_at values in the near future, one second apart,
      // so the 51 sources are the newest rows and the order is exact.
      const base = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 51; i++) {
        const { sourceId } = await setupSource({ createdAt: new Date(base + (i + 1) * 1000) });
        ids.push(sourceId);
      }
      const page1 = await admin.get("//api/admin/sources");
      expect(page1.status).toBe(200);
      const sources1 = page1.body.sources as { id: string }[];
      expect(sources1).toHaveLength(50);
      expect(typeof page1.body.next_cursor).toBe("string");
      // Newest first: the last-seeded source is first.
      expect(sources1[0]!.id).toBe(ids[50]);
      // The cursor is opaque: round-trip it verbatim, never decode it.
      const cursor = page1.body.next_cursor as string;
      const page2 = await admin.get("//api/admin/sources", { query: { cursor } });
      const sources2 = page2.body.sources as { id: string }[];
      // The second page holds the oldest of the 51 plus the sources earlier
      // tests in this file seeded; it is the last page either way.
      expect(sources2.map((s) => s.id)).toContain(ids[0]);
      expect(page2.body.next_cursor).toBeNull();
      // The two pages together hold exactly the 51 seeded sources (plus any
      // this file seeded earlier — filter to the ones this test made), with
      // no row repeated across the pages.
      const pageIds = [...sources1, ...sources2].map((s) => s.id);
      expect(new Set(pageIds).size).toBe(pageIds.length);
      for (const id of ids) expect(pageIds).toContain(id);
    });
  });

  describe("PUT/DELETE /api/admin/sources/:id/holdout", () => {
    test("404 for a bad id and an unknown id", async () => {
      const bad = await admin.put("//api/admin/sources/not-an-id/holdout", {}, { headers: originHeaders() });
      expect(bad.status).toBe(404);
      const unknown = await admin.put(`//api/admin/sources/${await videoId("admin-holdout-unknown")}/holdout`, {}, { headers: originHeaders() });
      expect(unknown.status).toBe(404);
      const unknownDel = await admin.delete(`//api/admin/sources/${await videoId("admin-holdout-unknown")}/holdout`, { headers: originHeaders() });
      expect(unknownDel.status).toBe(404);
    });

    test("PUT sets holdout, DELETE clears it; changed is false the second time; updated_at moves", async () => {
      const { sourceId } = await setupSource({ holdout: false, labels: [{ name: "cork", origin: "typed" }] });
      // Backdate the row an hour so the PUT must move updated_at to pass:
      // a server that never touched it would leave the old timestamp.
      const hourAgo = "now() - interval '1 hour'";
      await stack.db.query(`UPDATE sources SET updated_at = ${hourAgo} WHERE id = $1`, [sourceId]);
      await stack.db.query(`UPDATE clips SET updated_at = ${hourAgo} WHERE source_id = $1`, [sourceId]);
      await stack.db.query(
        `UPDATE labels SET updated_at = ${hourAgo} WHERE clip_id IN (SELECT id FROM clips WHERE source_id = $1)`,
        [sourceId],
      );
      const before = await stack.db.one<{ updated_at: Date }>(`SELECT updated_at FROM sources WHERE id = $1`, [sourceId]);
      // The export cursor taken before the PUT: the row must reappear past
      // it once the PUT moves updated_at to now.
      const exportBefore = await stack.pipeline().get("/labels/export");
      const cursorBefore = exportBefore.body.next_cursor as string;
      expect(typeof cursorBefore).toBe("string");
      const put = await admin.put(`//api/admin/sources/${sourceId}/holdout`, {}, { headers: originHeaders() });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ source_id: sourceId, holdout: true, changed: true });
      expect(put.headers.get("cache-control")).toBe("no-store");
      const afterPut = await stack.db.one<{ updated_at: Date; holdout: boolean }>(`SELECT updated_at, holdout FROM sources WHERE id = $1`, [sourceId]);
      expect(afterPut!.holdout).toBe(true);
      expect(afterPut!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
      const exportAfter = await stack.pipeline().get("/labels/export", { query: { since: cursorBefore } });
      const rowsAfter = exportAfter.body.rows as { source_id: string }[];
      expect(rowsAfter.map((r) => r.source_id)).toContain(sourceId);
      const putAgain = await admin.put(`//api/admin/sources/${sourceId}/holdout`, {}, { headers: originHeaders() });
      expect(putAgain.body).toEqual({ source_id: sourceId, holdout: true, changed: false });
      const del = await admin.delete(`//api/admin/sources/${sourceId}/holdout`, { headers: originHeaders() });
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ source_id: sourceId, holdout: false, changed: true });
      const delAgain = await admin.delete(`//api/admin/sources/${sourceId}/holdout`, { headers: originHeaders() });
      expect(delAgain.body).toEqual({ source_id: sourceId, holdout: false, changed: false });
    });
  });

  describe("GET /api/admin/sources/:id/pose", () => {
    test("401 without a session, 404 for a bad id and an unknown id", async () => {
      const { sourceId } = await setupSource({});
      expect((await stack.anonymous().get(`//api/admin/sources/${sourceId}/pose`)).status).toBe(401);
      expect((await admin.get(`//api/admin/sources/not-an-id/pose`)).status).toBe(404);
      expect((await admin.get(`//api/admin/sources/${await videoId("admin-pose-unknown")}/pose`)).status).toBe(404);
    });

    test("sha256 NULL is 422 BLOB_MISSING; a missing fake blob is 422 BLOB_MISSING", async () => {
      const un_ingested = await setupSource({});
      await stack.db.query(`UPDATE sources SET sha256 = NULL WHERE id = $1`, [un_ingested.sourceId]);
      const missing = await admin.get(`//api/admin/sources/${un_ingested.sourceId}/pose`);
      expect(missing.status).toBe(422);
      expect(missing.json).toEqual({
        error: { code: "BLOB_MISSING", message: "The pose blob is not ingested yet", details: {} },
      });
      const { sourceId } = await setupSource({});
      await stack.db.query(`UPDATE sources SET sha256 = $1 WHERE id = $2`, [await sha256Hex(encodeStagedTkp1({ frameCount: 10, rateHz: 10 })), sourceId]);
      stack.upstream.r2.delete(`poses/${sourceId}.tkp1.gz`);
      const gone = await admin.get(`//api/admin/sources/${sourceId}/pose`);
      expect(gone.status).toBe(422);
      expect(gone.json).toEqual({
        error: { code: "BLOB_MISSING", message: "The pose blob is not in storage", details: {} },
      });
    });

    test("a blob streaming past 64 MiB cuts the response short", async () => {
      // The cap is raised by the stream, not by getStream: the handler has
      // already answered 200 and the response errors mid-stream (see the
      // comment at the end of handleGetAdminSourcePose). So the pin is that
      // the body read fails after at most one chunk past the cap — never a
      // complete body, never a 422.
      const { sourceId } = await setupSource({});
      stack.upstream.r2.lieAboutLength(`poses/${sourceId}.tkp1.gz`, 64 * 1024 * 1024 + 1);
      const res = await fetch(`${stack.anonymous().origin}/api/admin/sources/${sourceId}/pose`, {
        headers: { Cookie: `${ADMIN_COOKIE}=${adminToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      const reader = res.body!.getReader();
      let total = 0;
      let errored = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
        }
      } catch {
        errored = true;
      }
      expect(errored).toBe(true);
      expect(total).toBeLessThanOrEqual(64 * 1024 * 1024 + 1024 * 1024);
    });

    test("success streams the exact bytes with application/gzip, nosniff, and no-store", async () => {
      const { sourceId, staged } = await setupSource({});
      const res = await fetch(`${stack.anonymous().origin}/api/admin/sources/${sourceId}/pose`, {
        headers: { Cookie: `${ADMIN_COOKIE}=${adminToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await res.arrayBuffer()).equals(staged)).toBe(true);
    });
  });

  describe("GET /api/admin/synonyms", () => {
    const seedPair = async (name: string, sameAs: string, accounts: number, submittedAt = new Date("2026-01-02T03:04:05.123456Z")) => {
      for (let i = 0; i < accounts; i++) {
        const hash = await candidateHash(`synonym-user-${name}-${sameAs}-${i}`);
        await stack.db.query(
          `INSERT INTO synonym_candidates (name, same_as, account_hash, submitted_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [name, sameAs, hash, submittedAt],
        );
      }
    };

    test("401 without a session; min validation", async () => {
      expect((await stack.anonymous().get("//api/admin/synonyms")).status).toBe(401);
      for (const min of ["0", "-1", "abc", "1.5"]) {
        const result = await admin.get("//api/admin/synonyms", { query: { min } });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: { code: "VALIDATION_ERROR", message: "min must be a whole number from 1", details: { field: "min" } },
        });
      }
    });

    test("rows carry accounts, canonicals, and first_submitted_at; min filters; ordering is accounts desc", async () => {
      await seedPair("cartwheel full twist", "cartfull", 2);
      await seedPair("raiz flip", "raiz", 1);
      await seedPair("double backflip", "gainer", 3);
      const all = await admin.get("//api/admin/synonyms");
      expect(all.status).toBe(200);
      expect(all.headers.get("cache-control")).toBe("no-store");
      const synonyms = all.body.synonyms as Record<string, unknown>[];
      expect(all.body.truncated).toBe(false);
      expect(synonyms.map((s) => s.name)).toEqual(["double backflip", "cartwheel full twist", "raiz flip"]);
      const top = synonyms[0]!;
      expect(top).toEqual({
        name: "double backflip",
        same_as: "gainer",
        accounts: 3,
        name_canonical: null,
        same_as_canonical: "gainer",
        first_submitted_at: "2026-01-02T03:04:05.123000Z",
      });
      const cartwheel = synonyms.find((s) => s.name === "cartwheel full twist")!;
      expect(cartwheel.same_as_canonical).toBe("cartfull");
      const min2 = await admin.get("//api/admin/synonyms", { query: { min: 2 } });
      const min2Names = (min2.body.synonyms as { name: string }[]).map((s) => s.name);
      expect(min2Names).toEqual(["double backflip", "cartwheel full twist"]);
      const min4 = await admin.get("//api/admin/synonyms", { query: { min: 4 } });
      expect(min4.body.synonyms).toEqual([]);
    });

    test("truncated is true past 100 pairs", async () => {
      for (let i = 0; i < 101; i++) {
        await seedPair(`trick-${i}`, `canonical-${i}`, 1);
      }
      const result = await admin.get("//api/admin/synonyms");
      const synonyms = result.body.synonyms as unknown[];
      expect(synonyms).toHaveLength(100);
      expect(result.body.truncated).toBe(true);
    });
  });

  describe("POST /api/admin/merges", () => {
    test("401 without a session; name validation names the bad side", async () => {
      // The Origin header is needed to reach the session check: without it
      // the admin write is 403 before any session lookup.
      expect((await stack.anonymous().post("//api/admin/merges", { name: "a", same_as: "b" }, { headers: originHeaders() })).status).toBe(401);
      const cases: { body: Record<string, unknown>; field: string }[] = [
        { body: { name: "", same_as: "b" }, field: "name" },
        { body: { same_as: "b" }, field: "name" },
        { body: { name: "x".repeat(65), same_as: "b" }, field: "name" },
        { body: { name: "a", same_as: "" }, field: "same_as" },
        { body: { name: "a" }, field: "same_as" },
        { body: { name: "a", same_as: "x".repeat(65) }, field: "same_as" },
        { body: { name: "cork", same_as: "CORK" }, field: "same_as" },
        { body: { name: "cork", same_as: " cork " }, field: "same_as" },
      ];
      for (const { body, field } of cases) {
        const result = await admin.post("//api/admin/merges", body, { headers: originHeaders() });
        expect(result.status).toBe(422);
        expect(result.json).toEqual({
          error: {
            code: "VALIDATION_ERROR",
            message: "name and same_as must be two different names of 1 to 64 characters",
            details: { field },
          },
        });
      }
    });

    test("two names already one trick answer merged false and change nothing", async () => {
      const before = await stack.db.one<{ n: number }>(`SELECT max(taxonomy_version)::int AS n FROM label_taxonomy`);
      const result = await admin.post("//api/admin/merges", { name: "cork", same_as: "corkscrew" }, { headers: originHeaders() });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ merged: false, name: "cork", canonical: "cork" });
      const after = await stack.db.one<{ n: number }>(`SELECT max(taxonomy_version)::int AS n FROM label_taxonomy`);
      expect(after?.n).toBe(before?.n);
    });

    test("a real merge remaps at a new version and drops the candidates it settles", async () => {
      // Names chosen to not collide with the synonyms tests above, whose
      // "raiz flip" → "raiz" pair would otherwise be dropped by this merge
      // too and change synonyms_dropped.
      const hash = await candidateHash("merge-user");
      await stack.db.query(`INSERT INTO label_candidates (name, account_hash) VALUES ('sideflip', $1)`, [hash]);
      await stack.db.query(
        `INSERT INTO synonym_candidates (name, same_as, account_hash) VALUES ('sideflip', 'side flip', $1), ('side flip', 'sideflip', $1)`,
        [hash],
      );
      const result = await admin.post("//api/admin/merges", { name: "sideflip", same_as: "side flip" }, { headers: originHeaders() });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        merged: true,
        name: "sideflip",
        canonical: "side flip",
        taxonomy_version: 2,
        remapped: 1,
        synonyms_dropped: 2,
        candidates_dropped: 1,
      });
      const rows = await stack.db.query<{ raw: string; canonical: string; taxonomy_version: number }>(
        `SELECT raw, canonical, taxonomy_version FROM label_taxonomy WHERE taxonomy_version = 2 ORDER BY raw`,
        [],
      );
      expect(rows).toEqual([
        { raw: "side flip", canonical: "side flip", taxonomy_version: 2 },
        { raw: "sideflip", canonical: "side flip", taxonomy_version: 2 },
      ]);
      expect(await stack.db.query(`SELECT 1 FROM label_candidates WHERE lower(name) = 'sideflip'`)).toHaveLength(0);
      expect(await stack.db.query(`SELECT 1 FROM synonym_candidates WHERE lower(name) = 'sideflip'`)).toHaveLength(0);
    });

    test("merging a canonical remaps every raw that resolved to it", async () => {
      // The previous merge test already bumped the version to 2, so this
      // merge lands at version 3.
      const result = await admin.post("//api/admin/merges", { name: "cork", same_as: "gainer" }, { headers: originHeaders() });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        merged: true,
        name: "cork",
        canonical: "gainer",
        taxonomy_version: 3,
        remapped: 2,
        synonyms_dropped: 0,
        candidates_dropped: 0,
      });
      const rows = await stack.db.query<{ raw: string; canonical: string }>(
        `SELECT raw, canonical FROM label_taxonomy WHERE taxonomy_version = 3 ORDER BY raw`,
        [],
      );
      expect(rows).toEqual([
        { raw: "cork", canonical: "gainer" },
        { raw: "corkscrew", canonical: "gainer" },
      ]);
    });
  });
});
