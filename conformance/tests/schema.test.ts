import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness/stack";

describe("schema", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({});
    // One source + clip so the label CHECK tests have a real parent row:
    // a dangling clip_id would fail the foreign key instead of the CHECK.
    await stack.db.query(
      `INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key) VALUES ($1, $2, 100, 10, 'tkp1', 'poses/schema.tkp1.gz') ON CONFLICT DO NOTHING`,
      ["e".repeat(64), "0".repeat(64)],
    );
    await stack.db.query(`INSERT INTO clips (source_id, start_frame, end_frame) VALUES ($1, 0, 10)`, ["e".repeat(64)]);
  });
  afterAll(() => stack.stop());

  test("all 16 migrations are applied", async () => {
    const rows = await stack.db.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`, []);
    expect(rows.map((r) => r.version)).toEqual([
      "20261011043547",
      "20261011043548",
      "20261012205902",
      "20261016130000",
      "20261017200538",
      "20261018080000",
      "20261113120000",
      "20261113130000",
      "20261113140000",
      "20261114050000",
      "20261115120000",
      "20261115130000",
      "20261117120000",
      "20261117120100",
      "20261119050000",
      "20261119120000",
    ]);
  });

  test("the v1 taxonomy seed rows exist", async () => {
    const rows = await stack.db.query<{ raw: string; canonical: string; taxonomy_version: number }>(
      `SELECT raw, canonical, taxonomy_version FROM label_taxonomy WHERE taxonomy_version = 1 ORDER BY raw`,
      [],
    );
    expect(rows).toEqual([
      { raw: "cartfull", canonical: "cartfull", taxonomy_version: 1 },
      { raw: "cork", canonical: "cork", taxonomy_version: 1 },
      { raw: "corkscrew", canonical: "cork", taxonomy_version: 1 },
      { raw: "gainer", canonical: "gainer", taxonomy_version: 1 },
      { raw: "hook", canonical: "hook", taxonomy_version: 1 },
      { raw: "scoot", canonical: "scoot", taxonomy_version: 1 },
    ]);
  });

  test("labels reject a trick_name with surrounding whitespace (btrim check)", async () => {
    const clip = await stack.db.one<{ id: string }>(`SELECT id FROM clips LIMIT 1`);
    await expect(
      stack.db.query(`INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES ($1, ' cork ', 'typed', 1)`, [
        clip!.id,
      ]),
    ).rejects.toThrow(/check constraint|violates check/i);
  });

  test("labels reject an empty trick_name", async () => {
    const clip = await stack.db.one<{ id: string }>(`SELECT id FROM clips LIMIT 1`);
    await expect(
      stack.db.query(`INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES ($1, '', 'typed', 1)`, [clip!.id]),
    ).rejects.toThrow(/check constraint|violates check/i);
  });

  test("sources reject a non-hex id", async () => {
    await expect(
      stack.db.query(
        `INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key) VALUES ('not-hex', $1, 10, 10, 'tkp1', 'poses/not-hex.tkp1.gz')`,
        ["0".repeat(64)],
      ),
    ).rejects.toThrow(/check constraint|violates check/i);
  });

  test("clips reject end_frame <= start_frame", async () => {
    await stack.db.query(
      `INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, keypoint_format, r2_key) VALUES ($1, $2, 100, 10, 'tkp1', 'poses/schema.tkp1.gz') ON CONFLICT DO NOTHING`,
      ["e".repeat(64), "0".repeat(64)],
    );
    await expect(
      stack.db.query(`INSERT INTO clips (source_id, start_frame, end_frame) VALUES ($1, 10, 10)`, ["e".repeat(64)]),
    ).rejects.toThrow(/check constraint|violates check/i);
  });

  test("the dead training-segment tables still exist but hold no rows", async () => {
    for (const table of ["training_segments", "training_segment_labels", "segment_sources"]) {
      const row = await stack.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(row?.n).toBe(0);
    }
  });
});
