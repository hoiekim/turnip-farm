/**
 * Minimal staged-blob builder for TKP1 fixtures, reimplemented from
 * POSE_FORMAT.md and src/ingest/tkp1-codec.ts — not imported from src/,
 * so the suite tests the wire format, not the Bun implementation's
 * encoder.
 *
 * Header (24 bytes, little-endian): magic "TKP1", version u16 = 1,
 * keypoint_count u16 = 17, frame_count u32, sample_rate_hz f32 = 10,
 * source_sample_rate_hz f32, flags u32 = 0. Each frame is 204 bytes:
 * 17 keypoints x (x, y, confidence) f32. A gap frame is 204 zero bytes
 * (all confidences exactly 0.0).
 */
import { gunzipSync, gzipSync } from "node:zlib";

export const TKP1_MAGIC = "TKP1";
export const TKP1_VERSION = 1;
export const TKP1_KEYPOINT_COUNT = 17;
export const TKP1_HEADER_BYTES = 24;
export const TKP1_FRAME_BYTES = 204;
export const CANONICAL_HZ = 10;

/** One deterministic non-gap frame: values derived from the frame index, so fixtures differ per test. */
export const makeFrame = (index: number, seed = 0): Uint8Array<ArrayBuffer> => {
  const frame = new Uint8Array(TKP1_FRAME_BYTES);
  const view = new DataView(frame.buffer);
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    const base = index * 0.37 + k * 0.11 + seed * 0.013;
    view.setFloat32(k * 12, Math.sin(base) * 100, true);
    view.setFloat32(k * 12 + 4, Math.cos(base) * 100, true);
    view.setFloat32(k * 12 + 8, 0.9, true);
  }
  return frame;
};

export const GAP_FRAME = new Uint8Array(TKP1_FRAME_BYTES);

export const encodeTkp1Header = (frameCount: number, sourceSampleRateHz: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(TKP1_HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = 0x54; out[1] = 0x4b; out[2] = 0x50; out[3] = 0x31; // "TKP1"
  view.setUint16(4, TKP1_VERSION, true);
  view.setUint16(6, TKP1_KEYPOINT_COUNT, true);
  view.setUint32(8, frameCount, true);
  view.setFloat32(12, CANONICAL_HZ, true);
  view.setFloat32(16, sourceSampleRateHz, true);
  view.setUint32(20, 0, true);
  return out;
};

export const encodeTkp1 = (frames: readonly Uint8Array<ArrayBuffer>[], sourceSampleRateHz: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * frames.length);
  out.set(encodeTkp1Header(frames.length, sourceSampleRateHz));
  frames.forEach((frame, i) => out.set(frame, TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES));
  return out;
};

export interface StagedTkp1Options {
  frameCount: number;
  rateHz: number;
  /** Frame bytes, in order; defaults to makeFrame(i, seed). Use GAP_FRAME entries for gap tests. */
  frames?: readonly Uint8Array<ArrayBuffer>[];
  seed?: number;
}

/** A gzipped staged TKP1 blob, ready to PUT to a staging upload URL. */
export const encodeStagedTkp1 = ({ frameCount, rateHz, frames, seed = 0 }: StagedTkp1Options): Buffer => {
  const built = frames ?? Array.from({ length: frameCount }, (_, i) => makeFrame(i, seed));
  if (built.length !== frameCount) throw new Error(`encodeStagedTkp1: ${built.length} frames for frameCount ${frameCount}`);
  return gzipSync(Buffer.from(encodeTkp1(built, rateHz)));
};

/** Decodes a (gunzipped) TKP1 blob the way the farm's decoder would, for assertions on canonical bytes. */
export const decodeTkp1 = (bytes: Uint8Array<ArrayBufferLike>): { frameCount: number; sourceSampleRateHz: number; frames: Uint8Array<ArrayBufferLike>[] } => {
  if (bytes.length < TKP1_HEADER_BYTES) throw new Error(`too short for a header (${bytes.length} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== TKP1_MAGIC) throw new Error(`bad magic ${JSON.stringify(magic)}`);
  if (view.getUint16(4, true) !== TKP1_VERSION) throw new Error("unsupported format_version");
  if (view.getUint16(6, true) !== TKP1_KEYPOINT_COUNT) throw new Error("unsupported keypoint_count");
  const frameCount = view.getUint32(8, true);
  if (bytes.length !== TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * frameCount) {
    throw new Error(`size ${bytes.length} != 24 + 204*${frameCount}`);
  }
  const frames: Uint8Array<ArrayBufferLike>[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(bytes.slice(TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES, TKP1_HEADER_BYTES + (i + 1) * TKP1_FRAME_BYTES));
  }
  return { frameCount, sourceSampleRateHz: view.getFloat32(16, true), frames };
};

export const gunzip = (bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> => gunzipSync(Buffer.from(bytes));

export const sha256Hex = async (bytes: Uint8Array<ArrayBufferLike>): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex");

export const isGapFrame = (frame: Uint8Array<ArrayBufferLike>): boolean => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    if (view.getFloat32(k * 12 + 8, true) !== 0) return false;
  }
  return true;
};
