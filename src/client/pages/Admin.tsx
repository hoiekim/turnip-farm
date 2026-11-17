import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { PosePlayer } from "../admin/PosePlayer";
import {
  AdminError,
  type AdminSource,
  type HoldoutFilter,
  type SourcePage,
  listSources,
  setHoldout,
  shortId,
} from "../admin/api";
import { CANONICAL_HZ, formatSeconds } from "../admin/pose";

// The maintainer's holdout page, at /admin (BACKEND_DESIGN.md §1.2.28,
// §7.3 admin endpoints). Every call carries the admin key, which the
// endpoints check; this page shows nothing until one is accepted. The key
// lives in this component's state only, so a reload asks for it again.
// The page shows no account ids: the endpoints return none.

const MARK_NOTE =
  "Holdout should be footage of people who never contribute: turnip-ml evaluates on it and never trains on it.";
const UNMARK_NOTE = "Unmarked, this source can be trained on again from turnip-ml's next export pull.";

const FILTERS: { value: HoldoutFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "false", label: "Not holdout" },
  { value: "true", label: "Holdout only" },
];

function KeyForm({ notice, onAccepted }: { notice: string | null; onAccepted: (key: string, holdouts: SourcePage) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(null);
    try {
      onAccepted(trimmed, await listSources(trimmed, "true", null));
    } catch (err) {
      if (err instanceof AdminError && err.status === 401) setError("That key was refused.");
      else if (err instanceof AdminError && err.status === 404)
        setError("The admin endpoints are off: TURNIP_ADMIN_KEY is not set on the farm.");
      else setError(err instanceof Error ? err.message : "The farm could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-key" onSubmit={(e) => void submit(e)}>
      <label htmlFor="admin-key">Admin key</label>
      <div className="admin-key-row">
        <input
          id="admin-key"
          type="password"
          autoComplete="current-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </div>
      {error && <p className="admin-error">{error}</p>}
    </form>
  );
}

function SourceRow({
  source,
  selected,
  onPlay,
  onSetHoldout,
}: {
  source: AdminSource;
  selected: boolean;
  onPlay: (source: AdminSource) => void;
  onSetHoldout: (source: AdminSource, holdout: boolean) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const names = [...new Set(source.clips.flatMap((c) => c.names))];
  const mark = !source.holdout;

  const confirm = async () => {
    setBusy(true);
    try {
      await onSetHoldout(source, mark);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`source-row${selected ? " is-selected" : ""}`}>
      <div className="source-main">
        <code title={source.id}>{shortId(source.id)}</code>
        {source.holdout && <span className="tag tag-holdout">holdout</span>}
        {source.quarantined && <span className="tag tag-quarantine">quarantined</span>}
        {!source.ingested && <span className="tag">not ingested</span>}
      </div>
      <div className="source-meta">
        <span>Registered {new Date(source.created_at).toLocaleString()}</span>
        <span>
          {source.frame_count} frames · {formatSeconds(source.frame_count / CANONICAL_HZ)}
        </span>
        <span>
          {source.clips.length} {source.clips.length === 1 ? "clip" : "clips"}
          {names.length > 0 ? `: ${names.join(", ")}` : ""}
        </span>
      </div>
      {confirming ? (
        <div className="confirm">
          <p>{mark ? MARK_NOTE : UNMARK_NOTE}</p>
          <div className="source-actions">
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void confirm()}>
              {mark ? "Yes, mark as holdout" : "Yes, unmark"}
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="source-actions">
          <button className="btn btn-ghost" type="button" disabled={!source.ingested} onClick={() => onPlay(source)}>
            {selected ? "Playing" : "Play pose"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirming(true)}>
            {mark ? "Mark as holdout" : "Unmark"}
          </button>
        </div>
      )}
    </li>
  );
}

interface Listing {
  sources: AdminSource[];
  cursor: string | null;
  state: "ready" | "loading" | "error";
  message?: string;
}

function useListing(adminKey: string, filter: HoldoutFilter, onKeyRefused: () => void, initial?: SourcePage) {
  const [listing, setListing] = useState<Listing>(
    initial
      ? { sources: initial.sources, cursor: initial.next_cursor, state: "ready" }
      : { sources: [], cursor: null, state: "loading" },
  );
  // The key check already fetched the first page of an initial listing.
  const skipFirstLoad = useRef(initial !== undefined);
  // A newer load (a filter change, a reload) supersedes one in flight.
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const requestId = ++requestRef.current;
      setListing((l) => ({ ...l, state: "loading" }));
      try {
        const page = await listSources(adminKey, filter, cursor);
        if (requestRef.current !== requestId) return;
        setListing((l) => ({
          sources: cursor === null ? page.sources : [...l.sources, ...page.sources],
          cursor: page.next_cursor,
          state: "ready",
        }));
      } catch (err) {
        if (requestRef.current !== requestId) return;
        if (err instanceof AdminError && err.status === 401) onKeyRefused();
        setListing((l) => ({ ...l, state: "error", message: err instanceof Error ? err.message : "Request failed." }));
      }
    },
    [adminKey, filter, onKeyRefused],
  );

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    void load(null);
  }, [load]);

  const replace = (updated: AdminSource) =>
    setListing((l) => ({
      ...l,
      sources: l.sources
        .map((s) => (s.id === updated.id ? updated : s))
        .filter((s) => filter === "all" || s.holdout === (filter === "true")),
    }));

  return { listing, reload: () => load(null), more: () => load(listing.cursor), replace };
}

function SourceList({
  listing,
  empty,
  selectedId,
  onPlay,
  onSetHoldout,
  onMore,
}: {
  listing: Listing;
  empty: string;
  selectedId: string | null;
  onPlay: (source: AdminSource) => void;
  onSetHoldout: (source: AdminSource, holdout: boolean) => Promise<void>;
  onMore: () => void;
}) {
  return (
    <>
      {listing.state === "error" && <p className="admin-error">{listing.message}</p>}
      {listing.sources.length === 0 && listing.state === "ready" && <p className="dim">{empty}</p>}
      <ul className="source-list">
        {listing.sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            selected={source.id === selectedId}
            onPlay={onPlay}
            onSetHoldout={onSetHoldout}
          />
        ))}
      </ul>
      {listing.state === "loading" && <p>Loading…</p>}
      {listing.cursor !== null && listing.state !== "loading" && (
        <p>
          <button className="btn btn-ghost" type="button" onClick={onMore}>
            Load more
          </button>
        </p>
      )}
    </>
  );
}

function Console({
  adminKey,
  initialHoldouts,
  onKeyRefused,
  onLock,
}: {
  adminKey: string;
  initialHoldouts: SourcePage;
  onKeyRefused: () => void;
  onLock: () => void;
}) {
  const [filter, setFilter] = useState<HoldoutFilter>("all");
  const [selected, setSelected] = useState<AdminSource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const playerRef = useRef<HTMLElement>(null);
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId]);
  const holdouts = useListing(adminKey, "true", onKeyRefused, initialHoldouts);
  const browse = useListing(adminKey, filter, onKeyRefused);

  const onSetHoldout = async (source: AdminSource, holdout: boolean) => {
    setActionError(null);
    try {
      await setHoldout(adminKey, source.id, holdout);
    } catch (err) {
      if (err instanceof AdminError && err.status === 401) onKeyRefused();
      setActionError(err instanceof Error ? err.message : "The change failed.");
      return;
    }
    const updated = { ...source, holdout };
    browse.replace(updated);
    if (selected?.id === source.id) setSelected(updated);
    await holdouts.reload();
  };

  return (
    <>
      <p>
        <button className="btn btn-ghost" type="button" onClick={onLock}>
          Lock
        </button>
      </p>
      {actionError && <p className="admin-error">{actionError}</p>}

      <section>
        <h2>Current holdouts</h2>
        <SourceList
          listing={holdouts.listing}
          empty="No source is flagged as holdout. turnip-ml won't train until at least one is."
          selectedId={selected?.id ?? null}
          onPlay={setSelected}
          onSetHoldout={onSetHoldout}
          onMore={() => void holdouts.more()}
        />
      </section>

      {selected && (
        <section ref={playerRef}>
          <h2>
            Pose <code title={selected.id}>{shortId(selected.id)}</code>
          </h2>
          <PosePlayer adminKey={adminKey} source={selected} onKeyRefused={onKeyRefused} />
        </section>
      )}

      <section>
        <h2>Sources</h2>
        <p className="dim">Newest first. Durations are at the canonical 10 Hz.</p>
        <div className="filter-row" role="radiogroup" aria-label="Holdout filter">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              className={`btn ${filter === f.value ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <SourceList
          listing={browse.listing}
          empty="No sources match."
          selectedId={selected?.id ?? null}
          onPlay={setSelected}
          onSetHoldout={onSetHoldout}
          onMore={() => void browse.more()}
        />
      </section>
    </>
  );
}

export function AdminPage() {
  const [session, setSession] = useState<{ key: string; holdouts: SourcePage } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = "Turnip — Holdouts";
    return () => {
      document.title = previous;
    };
  }, []);

  const onKeyRefused = useCallback(() => {
    setSession(null);
    setNotice("The admin key was refused. Enter it again.");
  }, []);

  return (
    <main className="page admin">
      <div className="wrap">
        <h1>Holdouts</h1>
        <p className="lead">
          The curated holdout: sources turnip-ml evaluates on and never trains on.
        </p>
        {session === null ? (
          <KeyForm
            notice={notice}
            onAccepted={(key, holdouts) => {
              setNotice(null);
              setSession({ key, holdouts });
            }}
          />
        ) : (
          <Console
            adminKey={session.key}
            initialHoldouts={session.holdouts}
            onKeyRefused={onKeyRefused}
            onLock={() => setSession(null)}
          />
        )}
      </div>
    </main>
  );
}
