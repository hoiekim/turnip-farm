import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consented, randomSub, sourceKey, videoId } from "../harness/apple";
import { seedClip, seedConsent, seedSession, seedSource } from "../harness/seed/contrib";
import { seedQuarantine, seedTaxonomyRow } from "../harness/seed/pipeline";
import { startStack, type Stack } from "../harness/stack";
import { encodeStagedTkp1, sha256Hex } from "../harness/tkp1";

const V1_TAXONOMY = [
  { raw: "cartfull", canonical: "cartfull", taxonomy_version: 1 },
  { raw: "cork", canonical: "cork", taxonomy_version: 1 },
  { raw: "corkscrew", canonical: "cork", taxonomy_version: 1 },
  { raw: "gainer", canonical: "gainer", taxonomy_version: 1 },
  { raw: "hook", canonical: "hook", taxonomy_version: 1 },
  { raw: "scoot", canonical: "scoot", taxonomy_version: 1 },
];

describe("export", () => {
  // The export reads the whole database, so each test gets a fresh stack:
  // rows one test seeds must not leak into another's page or cursor.
  let stack: Stack;
  beforeEach(async () => {
    stack = await startStack();
  });
  afterEach(() => stack?.stop());

  /** An ingested source attributed to a fresh user, with one clip + labels. */
  const setupExport = async (options: {
    labels?: { name: string; origin?: string }[];
    holdout?: boolean;
    attributed?: boolean;
    frameCount?: number;
  } = {}) => {
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`export-${userId}`);
    const key = sourceKey();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10 });
    await seedSource(stack, sourceId, {
      userId: options.attributed === false ? undefined : userId,
      sourceKey: key,
      frameCount: options.frameCount ?? 100,
      canonicalBytes: staged,
      holdout: options.holdout ?? false,
    });
    const clipId = await seedClip(stack, sourceId, {
      startFrame: 0,
      endFrame: 10,
      labels: options.labels ?? [{ name: "cork", origin: "typed" }],
    });
    return { client, userId, sourceId, key, clipId, staged };
  };

  /** Pin every row's updated_at to the same instant, so the export cursor ties. */
  const tieTimestamps = async (sourceIds: string[], at = "2026-01-02T03:04:05.123456Z") => {
    const ids = `{${sourceIds.join(",")}}`;
    await stack.db.query(`UPDATE sources SET updated_at = $1 WHERE id = ANY($2::char(64)[])`, [at, ids]);
    await stack.db.query(`UPDATE clips SET updated_at = $1 WHERE source_id = ANY($2::char(64)[])`, [at, ids]);
    await stack.db.query(
      `UPDATE labels SET updated_at = $1 WHERE clip_id IN (SELECT id FROM clips WHERE source_id = ANY($2::char(64)[]))`,
      [at, ids],
    );
  };

  test("401 with no key, a wrong key, and a user session token", async () => {
    const expected = {
      error: { code: "UNAUTHENTICATED", message: "Invalid pipeline key", details: {} },
    };
    const noKey = await stack.anonymous().get("/labels/export");
    expect(noKey.status).toBe(401);
    expect(noKey.json).toEqual(expected);
    expect(noKey.headers.get("www-authenticate")).toBe("Bearer");
    const wrongKey = await stack.anonymous().withBearer("wrong-pipeline-key").get("/labels/export");
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.json).toEqual(expected);
    const { client } = await seedSession(stack, randomSub());
    const userToken = await client.get("/labels/export");
    expect(userToken.status).toBe(401);
    expect(userToken.json).toEqual(expected);
  });

  test("an empty export: no rows, the v1 taxonomy, no contributors, a null cursor", async () => {
    const result = await stack.pipeline().get("/labels/export");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(result.body).toEqual({
      rows: [],
      taxonomy: V1_TAXONOMY,
      trick_contributors: [],
      contributor_minimum: 5,
      next_cursor: null,
    });
  });

  test("row shape: every field of one (source, clip, label) row", async () => {
    const { userId, sourceId, clipId, staged } = await setupExport({
      labels: [
        { name: "cork", origin: "typed" },
        { name: "gainer", origin: "vocabulary" },
      ],
    });
    await tieTimestamps([sourceId]);
    const result = await stack.pipeline().get("/labels/export");
    expect(result.status).toBe(200);
    const rows = result.body.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    const sha = await sha256Hex(staged);
    expect(rows[0]).toEqual({
      source_id: sourceId,
      r2_key: `poses/${sourceId}.tkp1.gz`,
      blob_sha256: sha,
      holdout: false,
      clip_id: clipId,
      start_frame: 0,
      end_frame: 10,
      proposal_model_version: null,
      suggested_names: [],
      suggestions_withheld: false,
      trick_name: "cork",
      canonical: "cork",
      origin: "typed",
      taxonomy_version: 1,
    });
    expect(rows[1]).toMatchObject({ trick_name: "gainer", canonical: "gainer", origin: "vocabulary" });
    // The two rows tie on row_cursor (one transaction's timestamps), so the
    // keyset falls to (clip_id, trick_name): cork before gainer.
    expect(result.body.next_cursor).toBeTruthy();
    expect(result.body.trick_contributors).toEqual([{ canonical: "cork", contributors: 1 }, { canonical: "gainer", contributors: 1 }]);
    void userId;
  });

  test("canonical resolution: greatest-version raw mapping, canonical itself, case and spacing, and no match", async () => {
    // A v2 rename: the raw "raiz" becomes the "raiz flip" trick.
    await seedTaxonomyRow(stack, "raiz", "raiz flip", 2);
    const { sourceId } = await setupExport({
      labels: [
        { name: "raiz", origin: "typed" },
        { name: "CORK", origin: "typed" },
        { name: "double backflip", origin: "typed" },
        { name: "cartfull", origin: "vocabulary" },
        // Interior double space: the export normalizes it to "raiz flip".
        { name: "raiz  flip", origin: "typed" },
      ],
    });
    await tieTimestamps([sourceId]);
    const result = await stack.pipeline().get("/labels/export");
    const rows = result.body.rows as { trick_name: string; canonical: string | null }[];
    expect(rows).toHaveLength(5);
    const byName = new Map(rows.map((r) => [r.trick_name, r.canonical]));
    expect(byName.get("raiz")).toBe("raiz flip");
    expect(byName.get("CORK")).toBe("cork");
    expect(byName.get("double backflip")).toBeNull();
    expect(byName.get("cartfull")).toBe("cartfull");
    expect(byName.get("raiz  flip")).toBe("raiz flip");
    const contributors = result.body.trick_contributors as { canonical: string; contributors: number }[];
    // The unmapped name counts as its normalized self.
    expect(contributors).toContainEqual({ canonical: "double backflip", contributors: 1 });
    expect(contributors).toContainEqual({ canonical: "raiz flip", contributors: 1 });
  });

  test("paging: following next_cursor returns the next page, then an empty page with a null cursor", async () => {
    const first = await setupExport({ labels: [{ name: "cork" }] });
    const second = await setupExport({ labels: [{ name: "gainer" }] });
    const third = await setupExport({ labels: [{ name: "hook" }] });
    // Distinct row_cursors, in insertion order.
    await tieTimestamps([first.sourceId], "2026-01-02T00:00:00.000000Z");
    await tieTimestamps([second.sourceId], "2026-01-02T00:00:01.000000Z");
    await tieTimestamps([third.sourceId], "2026-01-02T00:00:02.000000Z");
    const page1 = await stack.pipeline().get("/labels/export");
    const rows1 = page1.body.rows as { trick_name: string }[];
    expect(rows1.map((r) => r.trick_name)).toEqual(["cork", "gainer", "hook"]);
    const cursor = page1.body.next_cursor as string;
    expect(typeof cursor).toBe("string");
    // The cursor is opaque: round-trip it verbatim, never decode it.
    // Past the last row it yields an empty page with a null cursor.
    const page2 = await stack.pipeline().get("/labels/export", { query: { since: cursor } });
    expect(page2.body).toEqual({
      rows: [],
      taxonomy: expect.any(Array),
      trick_contributors: expect.any(Array),
      contributor_minimum: 5,
      next_cursor: null,
    });
    // An empty since means the first page.
    const page1Again = await stack.pipeline().get("/labels/export", { query: { since: "" } });
    expect((page1Again.body.rows as unknown[]).length).toBe(3);
  });

  test("keyset tie: rows sharing a row_cursor order by (clip_id, trick_name)", async () => {
    const first = await setupExport({ labels: [{ name: "gainer" }, { name: "cork" }] });
    const second = await setupExport({ labels: [{ name: "hook" }] });
    // Force the same row_cursor on both sources, then order by clip_id:
    // the first clip's id sorts before the second's (seedClip uses random
    // UUIDs, so read them back and assert the order the query promises).
    await tieTimestamps([first.sourceId, second.sourceId], "2026-01-03T00:00:00.000000Z");
    const result = await stack.pipeline().get("/labels/export");
    const rows = result.body.rows as { clip_id: string; trick_name: string }[];
    const sorted = [...rows].sort((a, b) =>
      a.clip_id === b.clip_id ? (a.trick_name < b.trick_name ? -1 : 1) : a.clip_id < b.clip_id ? -1 : 1,
    );
    expect(rows).toEqual(sorted);
    // Within one clip the tie falls to trick_name: cork before gainer.
    const firstClipRows = rows.filter((r) => r.clip_id === first.clipId);
    expect(firstClipRows.map((r) => r.trick_name)).toEqual(["cork", "gainer"]);
  });

  test("since validation: garbage, wrong shape, a bad UUID, and an empty trick name are 422", async () => {
    const badCursors = [
      "not-a-cursor",
      Buffer.from(JSON.stringify(["2026-01-02T00:00:00.000000Z", "not-a-uuid", "cork"]), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify(["2026-01-02T00:00:00.000000Z", crypto.randomUUID()]), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify(["2026-01-02T00:00:00.000000Z", crypto.randomUUID(), ""]), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify(["not-a-date", crypto.randomUUID(), "cork"]), "utf8").toString("base64url"),
    ];
    for (const since of badCursors) {
      const result = await stack.pipeline().get("/labels/export", { query: { since } });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "since must be the opaque cursor from a previous next_cursor",
          details: {},
        },
      });
    }
  });

  test("an open quarantine excludes the source's rows and contributors; a resolved one does not", async () => {
    const { sourceId } = await setupExport({ labels: [{ name: "cork" }] });
    const quarantineId = await seedQuarantine(stack, sourceId, { reason: "bad data" });
    const excluded = await stack.pipeline().get("/labels/export");
    expect(excluded.body.rows).toEqual([]);
    expect(excluded.body.trick_contributors).toEqual([]);
    await stack.db.query(`UPDATE data_quarantine SET resolved_at = now(), resolution = 'released' WHERE id = $1`, [quarantineId]);
    const included = await stack.pipeline().get("/labels/export");
    expect((included.body.rows as unknown[]).length).toBe(1);
    expect(included.body.trick_contributors).toEqual([{ canonical: "cork", contributors: 1 }]);
  });

  test("a source with sha256 NULL exports no rows", async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client);
    const sourceId = await videoId(`export-null-sha-${userId}`);
    const key = sourceKey();
    await seedSource(stack, sourceId, { userId, sourceKey: key });
    await seedClip(stack, sourceId, { labels: [{ name: "cork" }] });
    const result = await stack.pipeline().get("/labels/export");
    expect((result.body.rows as { source_id: string }[]).filter((r) => r.source_id === sourceId)).toHaveLength(0);
  });

  test("holdout: every row carries holdout true, and holdout sources never count contributors", async () => {
    const holdout = await setupExport({ labels: [{ name: "cork" }], holdout: true });
    const plain = await setupExport({ labels: [{ name: "cork" }] });
    const result = await stack.pipeline().get("/labels/export");
    const rows = result.body.rows as { source_id: string; holdout: boolean }[];
    expect(rows.find((r) => r.source_id === holdout.sourceId)?.holdout).toBe(true);
    expect(rows.find((r) => r.source_id === plain.sourceId)?.holdout).toBe(false);
    expect(result.body.trick_contributors).toEqual([{ canonical: "cork", contributors: 1 }]);
  });

  test("trick_contributors: one account twice is 1, two accounts is 2, no attribution is nobody", async () => {
    // One account contributing the same trick from two sources.
    const first = await setupExport({ labels: [{ name: "scoot" }] });
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client);
    const secondSourceId = await videoId(`export-scoot-2-${userId}`);
    await seedSource(stack, secondSourceId, {
      userId: first.userId,
      sourceKey: sourceKey(),
      canonicalBytes: encodeStagedTkp1({ frameCount: 10, rateHz: 10 }),
    });
    await seedClip(stack, secondSourceId, { labels: [{ name: "scoot" }] });
    // A second account, and a third source with no attribution at all.
    await setupExport({ labels: [{ name: "scoot" }] });
    await setupExport({ labels: [{ name: "scoot" }], attributed: false });
    const result = await stack.pipeline().get("/labels/export");
    const contributors = result.body.trick_contributors as { canonical: string; contributors: number }[];
    expect(contributors).toEqual([{ canonical: "scoot", contributors: 2 }]);
    // All four sources' rows export (the unattributed one's row is there),
    // but it counts for nobody.
    const rows = result.body.rows as { trick_name: string }[];
    expect(rows.filter((r) => r.trick_name === "scoot")).toHaveLength(4);
    void userId;
  });

  test("taxonomy carries the whole table, version then raw — including the v2 rename", async () => {
    await seedTaxonomyRow(stack, "raiz", "raiz flip", 2);
    const result = await stack.pipeline().get("/labels/export");
    const taxonomy = result.body.taxonomy as { raw: string; canonical: string; taxonomy_version: number }[];
    expect(taxonomy).toEqual([...V1_TAXONOMY, { raw: "raiz", canonical: "raiz flip", taxonomy_version: 2 }]);
  });
});
