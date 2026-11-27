/**
 * Seeding helpers for pipeline data: models, quarantine rows, extra
 * taxonomy versions, training-source pages.
 */
import type { Stack } from "../stack";
import { sha256Hex } from "../tkp1";

export interface SeedModelOptions {
  taxonomyVersion?: number;
  r2Key?: string;
  sha256?: string;
  byteSize?: number | null;
  minClientVersion?: string | null;
  inputDesc?: Record<string, unknown> | null;
  outputDesc?: Record<string, unknown> | null;
  valMetrics?: Record<string, unknown>;
  nameMetrics?: Record<string, unknown>;
  holdoutReportR2Key?: string | null;
  trainingRunId?: string | null;
  /** Promote at this time (default: now); null leaves the model unpromoted. */
  promotedAt?: Date | null;
  trainingSourceIds?: string[];
}

/** Inserts a `models` row (and its training sources) directly. Returns the model id. */
export const seedModel = async (stack: Stack, version: string, options: SeedModelOptions = {}): Promise<string> => {
  const sha256 = options.sha256 ?? (await sha256Hex(new TextEncoder().encode(`model:${version}`)));
  const [row] = await stack.db.query<{ id: string }>(
    `INSERT INTO models (version, taxonomy_version, r2_key, sha256, byte_size, min_client_version,
       input_desc, output_desc, val_metrics, name_metrics, holdout_report_r2_key, training_run_id, promoted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [
      version,
      options.taxonomyVersion ?? 1,
      options.r2Key ?? `models/${version}.onnx`,
      sha256,
      options.byteSize === undefined ? 12345 : options.byteSize,
      options.minClientVersion ?? null,
      options.inputDesc ? JSON.stringify(options.inputDesc) : null,
      options.outputDesc ? JSON.stringify(options.outputDesc) : null,
      JSON.stringify(options.valMetrics ?? {}),
      JSON.stringify(options.nameMetrics ?? {}),
      options.holdoutReportR2Key ?? null,
      options.trainingRunId ?? null,
      options.promotedAt === undefined ? new Date() : options.promotedAt,
    ],
  );
  for (const sourceId of options.trainingSourceIds ?? []) {
    await stack.db.query(
      `INSERT INTO model_training_sources (model_version, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [version, sourceId],
    );
  }
  return row!.id;
};

/** Inserts an open `data_quarantine` row directly. Returns the quarantine id. */
export const seedQuarantine = async (
  stack: Stack,
  sourceId: string,
  options: { reason?: string; metrics?: Record<string, unknown> | null; resolvedAt?: Date | null; resolution?: string | null } = {},
): Promise<string> => {
  const [row] = await stack.db.query<{ id: string }>(
    `INSERT INTO data_quarantine (source_id, reason, metrics, resolved_at, resolution)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      sourceId,
      options.reason ?? "regression",
      options.metrics ? JSON.stringify(options.metrics) : null,
      options.resolvedAt ?? null,
      options.resolution ?? null,
    ],
  );
  return row!.id;
};

/** Inserts one `label_taxonomy` row (an extra version or a rename). */
export const seedTaxonomyRow = async (stack: Stack, raw: string, canonical: string, version: number): Promise<void> => {
  await stack.db.query(
    `INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [raw, canonical, version],
  );
};

/** Inserts one staged `model_training_source_pages` row. */
export const seedTrainingSourcePage = async (
  stack: Stack,
  version: string,
  modelSha256: string,
  sourceId: string,
  stagedAt?: Date,
): Promise<void> => {
  await stack.db.query(
    `INSERT INTO model_training_source_pages (model_version, model_sha256, source_id, staged_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [version, modelSha256, sourceId, stagedAt ?? new Date()],
  );
};
