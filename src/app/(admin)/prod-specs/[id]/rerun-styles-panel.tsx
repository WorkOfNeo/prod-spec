"use client";

// Admin-only run list for the ProdSpec editor's Outputs tab. Lists EVERY style
// on this prod spec so an operator can run one, or run all. A run regenerates
// only the outputs that are NEW/MISSING or previously REJECTED — approved work
// is left alone, so a big spec doesn't blast everything back into review. Each
// row shows when the style last ran and whether that run was automated (Monday
// webhook / EAN handoff / cron sweep) or manual (a Re-run / bulk-run button).
//
// "Run all" enqueues a background BulkRunBatch (polled for DONE/TOTAL); a
// per-row "Run" fires that single style inline via the shared style re-run
// endpoint, scoped to exactly that row's new/missing + rejected outputs.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ProdSpecStyleRunList, StyleRunRow } from "@/lib/outputs/prod-spec-rerun";

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

export function RerunStylesPanel({
  prodSpecId,
  specActive,
  unsaved,
}: {
  prodSpecId: string;
  // Live editor state — the spec's active toggle and whether there are unsaved
  // output edits. Both gate a run: it must read PERSISTED outputs, and an
  // inactive spec can't generate.
  specActive: boolean;
  unsaved: boolean;
}) {
  const base = `/api/admin/prod-specs/${prodSpecId}/rerun-styles`;
  const storageKey = `prodspec-rerun:${prodSpecId}`;

  const [list, setList] = useState<ProdSpecStyleRunList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [query, setQuery] = useState("");
  // Styles currently being run via their per-row button (inline fetch pending).
  const [runningRows, setRunningRows] = useState<Set<string>>(() => new Set());
  // Per-row failures, keyed by styleId — cleared when that row runs again.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Manual "Refresh" affordance state (pull the latest queue/last-run without a
  // reload — useful to catch a style the automation just queued).
  const [refreshing, setRefreshing] = useState(false);

  const activeRun = batch != null && batch.finishedAt == null;

  // Pure fetchers — NO setState, so they can be awaited inside effects without
  // tripping react-hooks/set-state-in-effect. Callers setState after the await.
  const fetchList = useCallback(async (): Promise<ProdSpecStyleRunList | null> => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as ProdSpecStyleRunList;
    } catch {
      return null;
    }
  }, [base]);

  const fetchBatch = useCallback(
    async (id: string): Promise<Batch | null> => {
      try {
        const res = await fetch(`${base}?batchId=${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { batch: Batch | null };
        return data.batch;
      } catch {
        return null;
      }
    },
    [base],
  );

  // Load the list on mount and after each save (unsaved → false) so it reflects
  // the just-persisted outputs; resume an in-flight "Run all" recorded in
  // localStorage so it reappears after a reload.
  useEffect(() => {
    if (unsaved) return; // wait for autosave to flush before reading the list
    let cancelled = false;
    void (async () => {
      const l = await fetchList();
      if (cancelled) return;
      if (l) setList(l);
      setListLoading(false);
    })();
    const storedId = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (storedId) {
      void (async () => {
        const b = await fetchBatch(storedId);
        if (cancelled) return;
        if (b && b.finishedAt == null) setBatch(b);
        else window.localStorage.removeItem(storageKey);
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [unsaved, fetchList, fetchBatch, storageKey]);

  // Poll only while a "Run all" batch is in flight; refetch the list when it
  // settles so last-run stamps + to-run counts update.
  useEffect(() => {
    if (!activeRun || !batch) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      const b = await fetchBatch(batch.id);
      if (cancelled || !b) return;
      setBatch(b);
      if (b.finishedAt != null) {
        window.localStorage.removeItem(storageKey);
        const l = await fetchList();
        if (!cancelled && l) setList(l);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRun, batch, fetchBatch, fetchList, storageKey]);

  // Whether any style is currently queued or generating — drives the live
  // auto-refresh below and the "live" pill in the header.
  const anyInFlight = (list?.rows ?? []).some((r) => r.queueState != null);

  // Live refresh while work is in flight: re-poll the list so a row moves
  // Queued → Generating → done (last-run updates) without a manual reload. Only
  // runs while something is actually in flight, so an idle spec does no polling.
  useEffect(() => {
    if (!anyInFlight) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      const l = await fetchList();
      if (!cancelled && l) setList(l);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [anyInFlight, fetchList]);

  const runAllDisabledReason = unsaved
    ? "Save your output changes first"
    : !specActive
      ? "Activate this prod spec to run its styles"
      : list && list.toRerun === 0
        ? "Nothing to run — every style is up to date"
        : null;

  async function runAll() {
    if (!list || list.toRerun === 0 || submittingAll || activeRun || runAllDisabledReason) return;
    const ok = window.confirm(
      `Run ${list.toRerun} style${list.toRerun === 1 ? "" : "s"} on this prod spec?\n\n` +
        `Regenerates new/missing, rejected, and changed (non-approved) outputs ` +
        `(${list.withMissing} new · ${list.withRejected} rejected · ${list.withChanged} changed). ` +
        `Approved outputs are left alone — including any on an outdated layout. ` +
        `Renders in the background — safe to leave this page.`,
    );
    if (!ok) return;
    setSubmittingAll(true);
    setError(null);
    setDismissed(false);
    try {
      const res = await fetch(base, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { batchId?: string | null; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (!data.batchId) {
        setError("Nothing to run — the styles may have started generating elsewhere.");
        const l = await fetchList();
        if (l) setList(l);
        return;
      }
      window.localStorage.setItem(storageKey, data.batchId);
      const b = await fetchBatch(data.batchId);
      if (b) setBatch(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmittingAll(false);
    }
  }

  async function runOne(row: StyleRunRow) {
    if (row.inFlight || row.variantKeys.length === 0 || runningRows.has(row.id)) return;
    if (unsaved || !specActive) return;
    setRunningRows((prev) => new Set(prev).add(row.id));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      // Inline single-style re-run, scoped to this row's new/missing + rejected
      // outputs (approved work stays out of it). Runs to completion server-side.
      const res = await fetch(`/api/admin/styles/${row.id}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKeys: row.variantKeys }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setRowErrors((prev) => ({ ...prev, [row.id]: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      const l = await fetchList(); // refresh last-run + to-run for this row
      if (l) setList(l);
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [row.id]: e instanceof Error ? e.message : "Request failed" }));
    } finally {
      setRunningRows((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const l = await fetchList();
      if (l) setList(l);
    } finally {
      setRefreshing(false);
    }
  }

  const totalRows = list?.rows.length ?? 0;
  const filtered = useMemo(() => {
    const all = list?.rows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.poNumber ?? "").toLowerCase().includes(q),
    );
  }, [list, query]);

  const justFinished = batch != null && batch.finishedAt != null && !dismissed;

  return (
    <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800">Run styles</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Every style on this prod spec. Run one, or run all — only{" "}
            <span className="font-medium text-zinc-700">new/missing</span>,{" "}
            <span className="font-medium text-zinc-700">rejected</span>, and{" "}
            <span className="font-medium text-zinc-700">changed</span> (layout edited since) outputs
            regenerate; approved work is left alone (flagged{" "}
            <span className="font-medium text-orange-700">outdated</span> if its layout changed).
          </p>
        </div>
        <button
          type="button"
          onClick={runAll}
          disabled={
            submittingAll ||
            listLoading ||
            list == null ||
            list.toRerun === 0 ||
            activeRun ||
            Boolean(runAllDisabledReason)
          }
          title={runAllDisabledReason ?? "Run every style with outputs to regenerate on this prod spec"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          <RunAllIcon />
          {submittingAll ? "Starting…" : `Run all${list ? ` (${list.toRerun})` : ""}`}
        </button>
      </div>

      {/* Summary counts + filter. */}
      {list && list.totalStyles > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span className="text-zinc-600">{list.totalStyles} styles</span>
          <span>· {list.generatedStyles} generated</span>
          <span className="inline-flex items-center gap-1">
            · <Dot className="bg-zinc-900" /> {list.toRerun} to run
          </span>
          {list.changedApprovedStyles > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-1.5 py-0.5 font-medium text-orange-700"
              title="These styles have approved outputs on a layout that changed since — they won't rerun automatically; use each row's Run to refresh."
            >
              <WarnIcon /> {list.changedApprovedStyles} with outdated approved
            </span>
          )}
          {anyInFlight && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700"
              title="A style is queued or generating — the list is refreshing live"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> live
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Refresh the queue + last-run info"
              className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
            >
              <RefreshIcon spinning={refreshing} /> Refresh
            </button>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name / PO…"
              className="w-44 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
            />
          </div>
        </div>
      )}

      {/* "Run all" progress. */}
      {activeRun && batch && (
        <div className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-700">
              <Spinner />
              <span className="font-medium">Running all styles</span>
              <span className="tabular-nums text-zinc-500">
                {batch.done}/{batch.total}
              </span>
              {batch.failed > 0 && (
                <span className="tabular-nums text-red-600">· {batch.failed} failed</span>
              )}
            </div>
            {batch.createdByEmail && (
              <span className="shrink-0 text-xs text-zinc-400">started by {batch.createdByEmail}</span>
            )}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-900 transition-[width] duration-500"
              style={{
                width: `${batch.total > 0 ? Math.min(100, Math.round((batch.done / batch.total) * 100)) : 0}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-400">
            Rendering in the background — safe to leave this page; progress resumes when you return.
          </p>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
          {error}
        </p>
      )}

      {justFinished && batch && (
        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
          <span>
            ✓ Run complete · {batch.done}/{batch.total}
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
        </div>
      )}

      {/* The styles table. */}
      <div className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white">
        <div className="flex items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          <span className="min-w-0 flex-1">Style</span>
          <span className="hidden w-44 shrink-0 sm:block">Last run</span>
          <span className="w-40 shrink-0">To run</span>
          <span className="w-16 shrink-0 text-right">Run</span>
        </div>

        {listLoading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-zinc-500">
            <Spinner /> Loading styles…
          </div>
        ) : unsaved ? (
          <div className="px-3 py-6 text-xs text-zinc-500">
            Save your output changes to load the list…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-xs text-zinc-500">
            {totalRows === 0 ? "No styles on this prod spec yet." : "No styles match your filter."}
          </div>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-zinc-100 overflow-auto">
            {filtered.map((r) => (
              <StyleRow
                key={r.id}
                row={r}
                running={runningRows.has(r.id)}
                error={rowErrors[r.id]}
                disabled={unsaved || !specActive}
                onRun={() => void runOne(r)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StyleRow({
  row,
  running,
  error,
  disabled,
  onRun,
}: {
  row: StyleRunRow;
  running: boolean;
  error: string | undefined;
  disabled: boolean;
  onRun: () => void;
}) {
  const canRun = !row.inFlight && row.variantKeys.length > 0 && !disabled && !running;
  const runTitle = row.inFlight
    ? "A job is already running for this style"
    : row.variantKeys.length === 0
      ? row.readyCount > 0
        ? "Nothing to run — every output is approved or awaiting review"
        : "No ready outputs yet — awaiting data"
      : disabled
        ? "Save your changes / activate the spec first"
        : "Regenerate this style's new/missing + rejected outputs";

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/styles/${row.id}`}
            className="block truncate text-sm font-medium text-zinc-800 hover:underline"
            title={row.name}
          >
            {row.name}
          </Link>
          <div className="truncate text-[11px] text-zinc-400">
            {row.poNumber ? `PO ${row.poNumber}` : "no PO"} · {statusLabel(row.status)}
          </div>
        </div>

        <div className="hidden w-44 shrink-0 sm:block">
          {row.lastRun ? (
            <div className="flex flex-col gap-0.5">
              <span
                className="text-xs text-zinc-600"
                title={new Date(row.lastRun.at).toLocaleString()}
              >
                {timeAgo(row.lastRun.at)}
              </span>
              <KindBadge kind={row.lastRun.kind} source={row.lastRun.triggerSource} />
            </div>
          ) : (
            <span className="text-xs text-zinc-400">Never run</span>
          )}
        </div>

        <div className="w-40 shrink-0">
          <ToRunCell row={row} />
        </div>

        <div className="w-16 shrink-0 text-right">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            title={runTitle}
            className="inline-flex items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? <Spinner className="h-3.5 w-3.5" /> : "Run"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </li>
  );
}

function ToRunCell({ row }: { row: StyleRunRow }) {
  // In flight: distinguish Queued (accepted, waiting for the runner) from
  // Generating (actively rendering) — the "system is working on it" signal.
  if (row.queueState === "queued") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
        title="Accepted into the generation queue — waiting for the runner to pick it up"
      >
        <ClockIcon /> Queued
      </span>
    );
  }
  if (row.queueState === "running" || row.inFlight) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600"
        title="Rendering now"
      >
        <Spinner className="h-3 w-3" /> Generating
      </span>
    );
  }
  // Approved outputs whose layout changed since generation — a flag only, never
  // in the run set. Shown alongside run badges, or alone (instead of "up to
  // date") when there's nothing else to run.
  const outdatedFlag =
    row.changedApproved > 0 ? (
      <span
        className="inline-flex items-center gap-1 rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700"
        title={`${row.changedApproved} approved output${row.changedApproved === 1 ? "" : "s"} on an outdated layout — rerun manually to refresh (won't auto-run)`}
      >
        <WarnIcon /> {row.changedApproved} outdated
      </span>
    ) : null;

  if (row.variantKeys.length === 0) {
    if (outdatedFlag) return <span className="flex flex-wrap items-center gap-1">{outdatedFlag}</span>;
    return row.readyCount > 0 ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
        <Dot className="bg-emerald-500" /> up to date
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
        <Dot className="bg-zinc-300" /> awaiting data
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.missing > 0 && (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          {row.missing} new
        </span>
      )}
      {row.rejected > 0 && (
        <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
          {row.rejected} rejected
        </span>
      )}
      {row.changed > 0 && (
        <span
          className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
          title={`${row.changed} output${row.changed === 1 ? "" : "s"} whose layout changed since it last generated — will regenerate`}
        >
          {row.changed} changed
        </span>
      )}
      {outdatedFlag}
    </span>
  );
}

function KindBadge({ kind, source }: { kind: "automated" | "manual"; source: string }) {
  const cls =
    kind === "manual"
      ? "border-violet-200 bg-violet-50 text-violet-700"
      : "border-sky-200 bg-sky-50 text-sky-700";
  return (
    <span
      className={`inline-flex w-fit items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={triggerLabelClient(source)}
    >
      {kind === "manual" ? "Manual" : "Automated"}
    </span>
  );
}

// Style workflow status → friendlier label. Unknown values pass through.
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    PENDING: "pending",
    READY: "ready",
    GENERATING: "generating",
    AWAITING_REVIEW: "awaiting review",
    APPROVED: "approved",
    REJECTED: "rejected",
  };
  return map[status] ?? status.toLowerCase().replace(/_/g, " ");
}

// Client-side mirror of the trigger label (the server helper isn't importable
// into a client bundle without pulling in server-only deps — this is just the
// tooltip text). Kept tiny; the badge itself is driven by `kind`.
function triggerLabelClient(source: string): string {
  const labels: Record<string, string> = {
    WEBHOOK: "Monday webhook (fields landed)",
    MANUAL_RERUN: "manual re-run",
    ADMIN_TEST: "admin test",
    MANUAL_IMPORT: "import promotion",
    TICKET_RERUN: "rejection-ticket re-run",
    TICKET_FIX: "rejection-ticket fix",
    EAN_RESOLVED: "barcodes landed (EAN handoff)",
    CRON_SWEEP: "backlog sweep",
    MANUAL_BULK: "bulk run",
  };
  return labels[source] ?? source.toLowerCase().replace(/_/g, " ");
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} aria-hidden="true" />;
}

function WarnIcon() {
  return (
    <svg
      className="h-3 w-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="h-3 w-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${spinning ? "animate-spin" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`shrink-0 animate-spin text-zinc-500 ${className}`}
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
