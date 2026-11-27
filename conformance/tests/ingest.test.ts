import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, randomSub, signIn, sourceKey, videoId } from "../harness/apple";
import { startStack, type Stack } from "../harness/stack";
import {
  GAP_FRAME,
  decodeTkp1,
  encodeStagedTkp1,
  gunzip,
  isGapFrame,
  makeFrame,
  sha256Hex,
} from "../harness/tkp1";
import type { ApiClient } from "../harness/client";

const R2_HOST = "conformance-account.r2.cloudflarestorage.com";
const R2_BUCKET = "turnip-conformance";

describe("ingest", () => {
  let stack: Stack;
  beforeAll(async () => {
    // The poller runs every 100 ms; stacks without ingestIntervalMs never poll.
    stack = await startStack({ ingestIntervalMs: 100 });
  });
  afterAll(() => stack.stop());

  const setup = async () => {
    const { client, userId } = await signIn(stack, randomSub());
    await consented(client);
    return { client, userId };
  };

  const register = async (client: ApiClient, userId: string, label: string, frameCount = 10, rateHz = 10) => {
    const sourceId = await videoId(`ingest-${label}-${userId}`);
    const key = sourceKey();
    const result = await client.post("/sources", {
      video_id: sourceId,
      source_key: key,
      frame_count: frameCount,
      sample_rate: rateHz,
      keypoint_format: "tkp1",
      storefront_country: "USA",
    });
    expect(result.status).toBe(201);
    return { sourceId, key, uploadUrl: result.body.upload_url as string };
  };

  const uploadStaged = async (uploadUrl: string, bytes: Buffer, checksumB64?: string) => {
    const res = await fetch(stack.upstream.r2.localUrl(uploadUrl), {
      method: "PUT",
      headers: {
        "Content-Type": "application/gzip",
        "X-Amz-Checksum-Sha256": checksumB64 ?? createHash("sha256").update(bytes).digest("base64"),
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    expect(res.status).toBe(200);
  };

  const waitIngested = async (sourceId: string) => {
    const row = await stack.waitFor(async () => {
      const r = await stack.db.one<{ sha256: string | null; ingested_at: Date | null }>(
        `SELECT sha256, ingested_at FROM sources WHERE id = $1`,
        [sourceId],
      );
      return r?.sha256 ? r : null;
    }, { what: `ingest of ${sourceId}` });
    return row!;
  };

  const canonical = (sourceId: string) => stack.upstream.r2.get(`poses/${sourceId}.tkp1.gz`)?.body;

  test("a staged upload is ingested: sha256 set, canonical stored with the same frames at 10 Hz, staged deleted", async () => {
    const { client, userId } = await setup();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 7 });
    const { sourceId, uploadUrl } = await register(client, userId, "happy");
    const pollsBefore = stack.logCount("ingest poll:");
    await uploadStaged(uploadUrl, staged);
    const row = await waitIngested(sourceId);
    const canonicalBytes = canonical(sourceId)!;
    expect(row.sha256).toBe(await sha256Hex(canonicalBytes));
    expect(row.ingested_at).not.toBeNull();
    // The canonical gzip is the farm's own blocked framing (mtime 0, 64 KiB
    // deflate blocks), not a plain gzipSync of the payload — so the bytes
    // differ from the staged upload even at 10 Hz. What is identical is the
    // decoded content: same frames, same rate.
    expect([...canonicalBytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    const decoded = decodeTkp1(gunzip(canonicalBytes));
    const input = decodeTkp1(gunzip(staged));
    expect(decoded.frameCount).toBe(10);
    expect(decoded.sourceSampleRateHz).toBe(10);
    for (let i = 0; i < 10; i++) expect(Buffer.from(decoded.frames[i]!).equals(input.frames[i]!)).toBe(true);
    expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeUndefined();
    await stack.waitForLog("ingest poll: 1 ingested, 0 failed of 1 staged", { count: pollsBefore + 1 });
  });

  test("30 Hz resamples to 10 Hz: floor((n-1)/30*10)+1 frames, endpoints preserved", async () => {
    const { client, userId } = await setup();
    const frames = Array.from({ length: 31 }, (_, i) => makeFrame(i, 3));
    const staged = encodeStagedTkp1({ frameCount: 31, rateHz: 30, frames });
    const { sourceId, uploadUrl } = await register(client, userId, "resample30", 31, 30);
    await uploadStaged(uploadUrl, staged);
    await waitIngested(sourceId);
    const decoded = decodeTkp1(gunzip(canonical(sourceId)!));
    expect(decoded.frameCount).toBe(11);
    // The header keeps the source rate; the frames are the 10 Hz resample.
    expect(decoded.sourceSampleRateHz).toBe(30);
    expect(Buffer.from(decoded.frames[0]!).equals(frames[0]!)).toBe(true);
    expect(Buffer.from(decoded.frames[10]!).equals(frames[30]!)).toBe(true);
  });

  test("1 Hz upsamples 10x", async () => {
    const { client, userId } = await setup();
    const frames = Array.from({ length: 3 }, (_, i) => makeFrame(i, 5));
    const staged = encodeStagedTkp1({ frameCount: 3, rateHz: 1, frames });
    const { sourceId, uploadUrl } = await register(client, userId, "upsample1", 3, 1);
    await uploadStaged(uploadUrl, staged);
    await waitIngested(sourceId);
    const decoded = decodeTkp1(gunzip(canonical(sourceId)!));
    expect(decoded.frameCount).toBe(21);
    expect(decoded.sourceSampleRateHz).toBe(1);
    expect(Buffer.from(decoded.frames[0]!).equals(frames[0]!)).toBe(true);
    expect(Buffer.from(decoded.frames[20]!).equals(frames[2]!)).toBe(true);
  });

  test("gap frames survive resampling: a gap touching a canonical frame makes it a gap", async () => {
    const { client, userId } = await setup();
    const frames10 = Array.from({ length: 10 }, (_, i) => (i === 5 ? GAP_FRAME : makeFrame(i, 7)));
    const staged10 = encodeStagedTkp1({ frameCount: 10, rateHz: 10, frames: frames10 });
    const ten = await register(client, userId, "gap10");
    await uploadStaged(ten.uploadUrl, staged10);
    await waitIngested(ten.sourceId);
    const decoded10 = decodeTkp1(gunzip(canonical(ten.sourceId)!));
    expect(isGapFrame(decoded10.frames[5]!)).toBe(true);
    expect(isGapFrame(decoded10.frames[4]!)).toBe(false);
    // 30 Hz: input frame 15 sits at canonical frame 5's sample time.
    const frames30 = Array.from({ length: 31 }, (_, i) => (i === 15 ? GAP_FRAME : makeFrame(i, 7)));
    const staged30 = encodeStagedTkp1({ frameCount: 31, rateHz: 30, frames: frames30 });
    const thirty = await register(client, userId, "gap30", 31, 30);
    await uploadStaged(thirty.uploadUrl, staged30);
    await waitIngested(thirty.sourceId);
    const decoded30 = decodeTkp1(gunzip(canonical(thirty.sourceId)!));
    expect(isGapFrame(decoded30.frames[5]!)).toBe(true);
    expect(isGapFrame(decoded30.frames[4]!)).toBe(false);
  });

  test("re-contribution re-ingests: a new digest and a moved ingested_at", async () => {
    const { client, userId } = await setup();
    const first = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 11 });
    const { sourceId, key, uploadUrl } = await register(client, userId, "reingest");
    await uploadStaged(uploadUrl, first);
    const row1 = await waitIngested(sourceId);
    const second = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 99 });
    const again = await client.post("/sources", {
      video_id: sourceId,
      source_key: key,
      frame_count: 10,
      sample_rate: 10,
      keypoint_format: "tkp1",
      storefront_country: "USA",
    });
    expect(again.status).toBe(200);
    await uploadStaged(again.body.upload_url as string, second);
    const row2 = await stack.waitFor(async () => {
      const r = await stack.db.one<{ sha256: string | null; ingested_at: Date | null }>(
        `SELECT sha256, ingested_at FROM sources WHERE id = $1`,
        [sourceId],
      );
      return r?.sha256 && r.sha256 !== row1.sha256 ? r : null;
    }, { what: `re-ingest of ${sourceId}` });
    expect(row2!.sha256).toBe(await sha256Hex(canonical(sourceId)!));
    expect(row2!.ingested_at!.getTime()).toBeGreaterThan(row1.ingested_at!.getTime());
    const decoded2 = decodeTkp1(gunzip(canonical(sourceId)!));
    const input2 = decodeTkp1(gunzip(second));
    expect(decoded2.frameCount).toBe(10);
    for (let i = 0; i < 10; i++) expect(Buffer.from(decoded2.frames[i]!).equals(input2.frames[i]!)).toBe(true);
  });

  test("a staged checksum mismatch fails: sha256 stays NULL, no canonical blob, staged kept, warning logged", async () => {
    const { client, userId } = await setup();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 13 });
    const { sourceId, uploadUrl } = await register(client, userId, "badchecksum");
    await uploadStaged(uploadUrl, staged, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    await stack.waitForLog(`ingest failed for ${sourceId}: ingest failed [staged-checksum-mismatch]`);
    const row = await stack.db.one<{ sha256: string | null }>(`SELECT sha256 FROM sources WHERE id = $1`, [sourceId]);
    expect(row?.sha256).toBeNull();
    expect(canonical(sourceId)).toBeUndefined();
    expect(stack.upstream.r2.get(`staging/${sourceId}.tkp1.gz`)).toBeDefined();
    // Clean up: a poisoned staged object is re-attempted by every poll and
    // would add a failure to every later test's poll summary.
    stack.upstream.r2.delete(`staging/${sourceId}.tkp1.gz`);
  });

  test("a staged key with no source row fails as unknown-source and the poll still ingests the good one", async () => {
    const { client, userId } = await setup();
    const orphanId = await videoId(`ingest-orphan-${userId}`);
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 17 });
    stack.upstream.r2.put(`staging/${orphanId}.tkp1.gz`, staged, createHash("sha256").update(staged).digest("base64"));
    const good = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 19 });
    const { sourceId, uploadUrl } = await register(client, userId, "good-after-orphan");
    await uploadStaged(uploadUrl, good);
    // The orphan fails, the good source still ingests: one poisoned upload
    // does not stall the rest of the poll.
    await stack.waitForLog(`ingest failed for ${orphanId}: ingest failed [unknown-source]`);
    await waitIngested(sourceId);
    stack.upstream.r2.delete(`staging/${orphanId}.tkp1.gz`);
  });

  test("non-matching staging keys are ignored: not counted, not deleted", async () => {
    const { client, userId } = await setup();
    const junk = Buffer.from("not a staged upload");
    stack.upstream.r2.put(`staging/junk.txt`, junk);
    stack.upstream.r2.put(`staging/ABCDEF.tkp1.gz`, junk);
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 23 });
    const { sourceId, uploadUrl } = await register(client, userId, "junk-keys");
    await uploadStaged(uploadUrl, staged);
    await stack.waitForLog(`ingest poll: 1 ingested, 0 failed of 1 staged`);
    await waitIngested(sourceId);
    expect(stack.upstream.r2.get(`staging/junk.txt`)).toBeDefined();
    expect(stack.upstream.r2.get(`staging/ABCDEF.tkp1.gz`)).toBeDefined();
  });

  test("R2 LIST 5xx warns twice, then the third in a row is an error", async () => {
    const skippedBefore = stack.logCount("ingest poll skipped:");
    const failedBefore = stack.logCount("ingest poll failed:");
    stack.upstream.r2.failNext("LIST", 500);
    await stack.waitForLog("ingest poll skipped: R2 LIST answered HTTP 500 (no code), next try in 100ms", {
      count: skippedBefore + 1,
    });
    stack.upstream.r2.failNext("LIST", 500);
    await stack.waitForLog("ingest poll skipped: R2 LIST answered HTTP 500 (no code), next try in 100ms", {
      count: skippedBefore + 2,
    });
    stack.upstream.r2.failNext("LIST", 500);
    await stack.waitForLog("ingest poll failed:", { count: failedBefore + 1 });
    // The next poll recovers on its own: a fresh staged upload ingests.
    const { client, userId } = await setup();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 31 });
    const { sourceId, uploadUrl } = await register(client, userId, "after-list-errors");
    await uploadStaged(uploadUrl, staged);
    await waitIngested(sourceId);
  });

  test("a source deleted mid-ingest fails as source-vanished", async () => {
    const { client, userId } = await setup();
    const staged = encodeStagedTkp1({ frameCount: 10, rateHz: 10, seed: 29 });
    const { sourceId, uploadUrl } = await register(client, userId, "vanish");
    const release = stack.upstream.r2.gateGet(`staging/${sourceId}.tkp1.gz`);
    // Snapshot the staged-GET count before the upload: earlier tests' GETs
    // are still in the hub log, so an absolute count would match immediately.
    const getsBefore = stack.upstream.hub.seen(R2_HOST, `/${R2_BUCKET}/staging/`).length;
    try {
      await uploadStaged(uploadUrl, staged);
      // The ingest's staged GET has arrived and is held by the gate.
      await stack.waitFor(
        () => stack.upstream.hub.seen(R2_HOST, `/${R2_BUCKET}/staging/`).length >= getsBefore + 1,
        { what: `staged GET for ${sourceId}` },
      );
      await stack.db.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      release();
      await stack.waitForLog(`ingest failed for ${sourceId}: ingest failed [source-vanished]`);
      await stack.waitForLog(`ingest poll: 0 ingested, 1 failed of 1 staged`);
      stack.upstream.r2.delete(`staging/${sourceId}.tkp1.gz`);
    } finally {
      release();
    }
  });
});
