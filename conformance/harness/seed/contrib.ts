/**
 * Seeding helpers for contribution data. Prefer the API for anything an
 * endpoint creates; these are for rows no endpoint creates (expired
 * sessions, old timestamps, `sha256` values, quarantine rows) and for
 * read-back assertions.
 */
import { randomBytes } from "node:crypto";
import { REFRESH_TOKEN_KEY_B64 } from "../config";
import type { ApiClient } from "../client";
import type { Stack } from "../stack";
import { sha256Hex } from "../tkp1";
import { sourceKey as newSourceKey } from "../apple";

/** The HMAC-SHA-256 account hash for label/synonym candidates, recomputed from the harness refresh-token key (src/labels.ts). */
let candidateKeyPromise: Promise<CryptoKey> | undefined;
export const candidateHash = async (userId: string): Promise<string> => {
  candidateKeyPromise ??= (async () => {
    const raw = Buffer.from(REFRESH_TOKEN_KEY_B64, "base64");
    const base = await crypto.subtle.importKey("raw", raw as unknown as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("turnip-farm label candidates v1") },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
  })();
  const mac = await crypto.subtle.sign("HMAC", await candidateKeyPromise, new TextEncoder().encode(userId));
  return Buffer.from(mac).toString("hex");
};

export const seedSession = async (
  stack: Stack,
  userId: string,
  options: { isBlocked?: boolean; lastUsedAt?: Date; lastActiveAt?: Date; expiresInSec?: number } = {},
): Promise<{ client: ApiClient; token: string; userId: string }> => {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await stack.db.query(
    `INSERT INTO users (id, is_blocked, last_active_at) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET is_blocked = EXCLUDED.is_blocked, last_active_at = EXCLUDED.last_active_at`,
    [userId, options.isBlocked ?? false, options.lastActiveAt ?? now],
  );
  await stack.db.query(
    `INSERT INTO sessions (user_id, token_hash, last_used_at, expires_at) VALUES ($1, $2, $3, $4)`,
    [
      userId,
      await sha256Hex(new TextEncoder().encode(token)),
      options.lastUsedAt ?? now,
      new Date(now.getTime() + (options.expiresInSec ?? 90 * 24 * 60 * 60) * 1000),
    ],
  );
  return { client: stack.anonymous().withBearer(token), token, userId };
};

/** Inserts a blocked user (no session). */
export const seedBlockedUser = async (stack: Stack, userId: string): Promise<void> => {
  await stack.db.query(
    `INSERT INTO users (id, is_blocked) VALUES ($1, true) ON CONFLICT (id) DO UPDATE SET is_blocked = true`,
    [userId],
  );
};

/** Records a consent row for a user. */
export const seedConsent = async (stack: Stack, userId: string, disclosureVersion = 3): Promise<void> => {
  await stack.db.query(
    `INSERT INTO consents (user_id, disclosure_version) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, disclosureVersion],
  );
};

export interface SeedSourceOptions {
  userId?: string;
  sourceKey?: string;
  frameCount?: number;
  sampleRate?: number;
  /** Canonical blob bytes (already gzipped); stored in FakeR2 and hashed into `sha256`. */
  canonicalBytes?: Buffer;
  /** Explicit sha256 without storing bytes (e.g. a blob the fake does not hold). */
  sha256?: string | null;
  holdout?: boolean;
  createdAt?: Date;
  /** Attribute the source to `userId` (default: yes when userId is given). */
  attribute?: boolean;
}

export interface SeededSource {
  sourceId: string;
  sourceKey: string;
  r2Key: string;
}

/**
 * Inserts a `sources` row directly, with an optional canonical blob in
 * FakeR2 and an attribution row. The source key is returned (the API
 * never reveals it again).
 */
export const seedSource = async (stack: Stack, sourceId: string, options: SeedSourceOptions = {}): Promise<SeededSource> => {
  const key = options.sourceKey ?? newSourceKey();
  const r2Key = `poses/${sourceId}.tkp1.gz`;
  let sha256: string | null = options.sha256 ?? null;
  if (options.canonicalBytes) {
    sha256 = await sha256Hex(options.canonicalBytes);
    stack.upstream.r2.put(r2Key, options.canonicalBytes, sha256, "application/gzip");
  }
  await stack.db.query(
    `INSERT INTO sources (id, frame_count, sample_rate, keypoint_format, r2_key, sha256, source_key_hash, holdout, created_at, updated_at)
     VALUES ($1, $2, $3, 'tkp1', $4, $5, $6, $7, $8, $8)`,
    [
      sourceId,
      options.frameCount ?? 100,
      options.sampleRate ?? 10,
      r2Key,
      sha256,
      await sha256Hex(new TextEncoder().encode(key)),
      options.holdout ?? false,
      options.createdAt ?? new Date(),
    ],
  );
  if (options.userId !== undefined && (options.attribute ?? true)) {
    await stack.db.query(
      `INSERT INTO source_attribution (source_id, user_id) VALUES ($1, $2) ON CONFLICT (source_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [sourceId, options.userId],
    );
  }
  return { sourceId, sourceKey: key, r2Key };
};

/** Puts a staged blob in FakeR2, the way a client upload would. Returns its checksum. */
export const seedStagedBlob = async (stack: Stack, sourceId: string, bytes: Buffer): Promise<string> => {
  const checksum = await sha256Hex(bytes);
  stack.upstream.r2.put(`staging/${sourceId}.tkp1.gz`, bytes, Buffer.from(checksum, "hex").toString("base64"), "application/gzip");
  return checksum;
};

export interface SeedClipOptions {
  startFrame?: number;
  endFrame?: number;
  autoDetected?: boolean;
  labels?: { name: string; origin?: string; taxonomyVersion?: number }[];
  proposalModelVersion?: string | null;
  suggestedNames?: string[];
  suggestionsWithheld?: boolean;
  createdAt?: Date;
}

/** Inserts a clip row (and its labels) directly. Returns the clip id. */
export const seedClip = async (stack: Stack, sourceId: string, options: SeedClipOptions = {}): Promise<string> => {
  const clipId = crypto.randomUUID();
  const suggested = options.suggestedNames ?? [];
  await stack.db.query(
    `INSERT INTO clips (id, source_id, start_frame, end_frame, auto_detected, proposal_model_version, suggested_names, suggestions_withheld, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      clipId,
      sourceId,
      options.startFrame ?? 0,
      options.endFrame ?? 10,
      options.autoDetected ?? false,
      options.proposalModelVersion ?? null,
      `{${suggested.map((n) => `"${n.replaceAll('"', '\\"')}"`).join(",")}}`,
      options.suggestionsWithheld ?? false,
      options.createdAt ?? new Date(),
    ],
  );
  for (const label of options.labels ?? []) {
    await stack.db.query(
      `INSERT INTO labels (clip_id, trick_name, origin, taxonomy_version) VALUES ($1, $2, $3, $4)`,
      [clipId, label.name, label.origin ?? "typed", label.taxonomyVersion ?? 1],
    );
  }
  return clipId;
};
