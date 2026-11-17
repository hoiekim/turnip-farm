// Calls to the admin endpoints (BACKEND_DESIGN.md §7.3). The admin key is
// passed in by the page, which keeps it in memory only: it is never put in
// storage, a cookie or the URL.

export interface AdminClip {
  id: string;
  start_frame: number;
  end_frame: number;
  names: string[];
}

export interface AdminSource {
  id: string;
  created_at: string;
  frame_count: number;
  sample_rate: number;
  ingested: boolean;
  holdout: boolean;
  quarantined: boolean;
  clips: AdminClip[];
}

export interface SourcePage {
  sources: AdminSource[];
  next_cursor: string | null;
}

export type HoldoutFilter = "all" | "true" | "false";

/** A refused or failed admin call. `status` is the HTTP status, 0 for a network failure. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

async function call(adminKey: string, method: string, path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new AdminError(0, null, "The farm could not be reached.");
  }
  if (res.ok) return res;
  let code: string | null = null;
  let message = `Request failed (HTTP ${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // A non-JSON body (a proxy error page) keeps the generic message.
  }
  throw new AdminError(res.status, code, message);
}

export async function listSources(adminKey: string, filter: HoldoutFilter, cursor: string | null): Promise<SourcePage> {
  const params = new URLSearchParams({ holdout: filter });
  if (cursor !== null) params.set("cursor", cursor);
  const res = await call(adminKey, "GET", `/api/admin/sources?${params}`);
  return (await res.json()) as SourcePage;
}

export async function setHoldout(adminKey: string, sourceId: string, holdout: boolean): Promise<void> {
  await call(adminKey, holdout ? "PUT" : "DELETE", `/api/admin/sources/${sourceId}/holdout`);
}

export async function fetchPoseBlob(adminKey: string, sourceId: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await call(adminKey, "GET", `/api/admin/sources/${sourceId}/pose`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The first 12 hex characters of a video id. */
export function shortId(id: string): string {
  return id.slice(0, 12);
}
