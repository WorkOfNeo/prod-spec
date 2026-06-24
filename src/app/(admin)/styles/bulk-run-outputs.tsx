"use client";

// Admin-only "Run all outputs" control for the /styles toolbar. Enqueues a
// full re-run for every style in the operator's CURRENT filtered view (the
// ids are passed in from the client-side filter — same list the table shows),
// then shows a DONE/TOTAL progress bar polled from the BulkRunBatch row so the
// run survives navigating away and back. Rendered only for ADMINs by the table.

import { useEffect, useState } from "react";

type Batch = {
  id: string;
  label: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  createdByEmail: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const POLL_MS = 2000;
// How long after it finishes a batch still shows its result on load, so an
// admin returning shortly after sees "done", but a day-old run doesn't
// resurface a stale banner.
const RECENT_MS = 30 * 60 * 1000;

// Fetch the latest batch + decide whether a finished one is recent enough to
// still surface. Lives outside the component so the Date.now() recency check
// never runs during render (React purity) — only from effects/handlers.
async function loadLatest(): Promise<{ batch: Batch | null; finishedFresh: boolean }> {
  const res = await fetch("/api/admin/styles/bulk-rerun", { cache: "no-store" });
  if (!res.ok) return { batch: null, finishedFresh: false };
  const data = (await res.json()) as { batch: Batch | null };
  const b = data.batch;
  const finishedFresh =
    b?.finishedAt != null && Date.now() - new Date(b.finishedAt).getTime() < RECENT_MS;
  return { batch: b, finishedFresh: Boolean(finishedFresh) };
}

export function BulkRunOutputs({
  styleIds,
  filterLabel,
}: {
  // The current filtered set, in table order. Length drives the button label.
  styleIds: string[];
  // Human description of the active filter — stored on the batch so the
  // progress widget reads "Customer: Netto · 42 styles", not just a count.
  filterLabel: string;
}) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [finishedFresh, setFinishedFresh] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const active = batch != null && batch.finishedAt == null;

  // Read once on mount so an in-flight (or just-finished) run reappears after
  // navigating away and back.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await loadLatest();
      if (cancelled) return;
      setBatch(r.batch);
      setFinishedFresh(r.finishedFresh);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll only while a run is in flight (mirrors the sync-progress poller).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function tick() {
      const r = await loadLatest();
      if (cancelled) return;
      setBatch(r.batch);
      setFinishedFresh(r.finishedFresh);
    }
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  async function runAll() {
    if (styleIds.length === 0 || submitting || active) return;
    const n = styleIds.length;
    const ok = window.confirm(
      `Generate outputs for ${n} style${n === 1 ? "" : "s"} in the current view?\n\n` +
        `Runs only each style's ready, not-yet-generated outputs, in the background — ` +
        `it may take a while. Styles with nothing ready are skipped.`,
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    setDismissed(false);
    try {
      const res = await fetch("/api/admin/styles/bulk-rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleIds, label: filterLabel }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        batchId?: string | null;
        enqueued?: number;
        skipped?: number;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (!data.batchId) {
        const skipped = data.skipped ?? n;
        setError(
          `Nothing to run — ${skipped} style${skipped === 1 ? "" : "s"} skipped ` +
            `(no ready, un-generated outputs — already generated, not ready, ` +
            `already running, or no active prod spec).`,
        );
        return;
      }
      // Pick up the new batch and let the poll effect take over.
      const r = await loadLatest();
      setBatch(r.batch);
      setFinishedFresh(r.finishedFresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const showCompleted = !active && finishedFresh && !dismissed;

  // In-flight: the progress card replaces the button (one run at a time).
  if (active && batch) {
    const pct = batch.total > 0 ? Math.min(100, Math.round((batch.done / batch.total) * 100)) : 0;
    return (
      <div className="mb-4 rounded-md border border-zinc-200 bg-white px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-700">
            <Spinner />
            <span className="font-medium">Running outputs</span>
            <span className="tabular-nums text-zinc-500">
              {batch.done}/{batch.total}
            </span>
            {batch.failed > 0 && (
              <span className="tabular-nums text-red-600">· {batch.failed} failed</span>
            )}
            <span className="truncate text-xs text-zinc-400" title={batch.label}>
              · {batch.label}
            </span>
          </div>
          {batch.createdByEmail && (
            <span className="shrink-0 text-xs text-zinc-400">started by {batch.createdByEmail}</span>
          )}
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-zinc-900 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-400">
          Rendering in the background — safe to leave this page; progress resumes when you return.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
      {error && (
        <span className="mr-auto rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
          {error}
        </span>
      )}
      {showCompleted && batch && (
        <span className="mr-auto inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
          <span>
            ✓ Outputs generated · {batch.done}/{batch.total}
            {batch.failed > 0 ? ` · ${batch.failed} failed` : ""}
          </span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="text-emerald-600 hover:text-emerald-900"
          >
            ✕
          </button>
        </span>
      )}
      <button
        type="button"
        onClick={runAll}
        disabled={styleIds.length === 0 || submitting}
        title={
          styleIds.length === 0
            ? "No styles in the current view"
            : "Enqueue a full re-run for every style in the current filtered view"
        }
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
      >
        <RunAllIcon />
        {submitting ? "Starting…" : `Run all outputs (${styleIds.length})`}
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 shrink-0 animate-spin text-zinc-500"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function RunAllIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
