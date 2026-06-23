"use client";

// Admin-only "Rerun all styles" panel for the ProdSpec editor's Outputs tab.
// After an operator swaps the spec's outputs, this regenerates the spec's
// ALREADY-GENERATED styles — but only the outputs that are NEW/MISSING or
// previously REJECTED (approved / awaiting-review outputs are left alone, so a
// big spec doesn't blast everything back into review). It surfaces the
// rejected / new-missing breakdown + an "affected styles" list so the operator
// can see what will run, then polls a BulkRunBatch for DONE/TOTAL progress.

import { useCallback, useEffect, useState } from "react";

type Plan = {
  active: boolean;
  generatedStyles: number;
  toRerun: number;
  withMissing: number;
  withRejected: number;
  sample: Array<{ id: string; name: string; missing: number; rejected: number }>;
};

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
  // Live editor state — the spec's active toggle and whether there are
  // unsaved output edits. Both gate the run: the rerun must read PERSISTED
  // outputs, and an inactive spec can't generate.
  specActive: boolean;
  unsaved: boolean;
}) {
  const base = `/api/admin/prod-specs/${prodSpecId}/rerun-styles`;
  const storageKey = `prodspec-rerun:${prodSpecId}`;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const activeRun = batch != null && batch.finishedAt == null;

  // Pure fetchers — NO setState, so they can be awaited inside effects without
  // tripping react-hooks/set-state-in-effect. Callers setState after the await
  // (the same shape as the /styles bulk-run progress widget).
  const fetchPlan = useCallback(async (): Promise<Plan | null> => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as Plan;
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

  // Load the plan on mount and after each save (unsaved → false) so the counts
  // reflect the just-persisted outputs; resume an in-flight run recorded in
  // localStorage so it reappears after a reload. All setState runs after an
  // await inside the effect's async closure.
  useEffect(() => {
    if (unsaved) return; // wait for the autosave to flush before reading the plan
    let cancelled = false;
    void (async () => {
      const p = await fetchPlan();
      if (cancelled) return;
      if (p) setPlan(p);
      setPlanLoading(false);
    })();
    const storedId = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (storedId) {
      void (async () => {
        const b = await fetchBatch(storedId);
        if (cancelled) return;
        if (b && b.finishedAt == null) setBatch(b);
        else window.localStorage.removeItem(storageKey); // stale / finished — don't resurface
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [unsaved, fetchPlan, fetchBatch, storageKey]);

  // Poll only while a run is in flight (setState in a subscription callback,
  // after the await — the supported effect pattern).
  useEffect(() => {
    if (!activeRun || !batch) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      const b = await fetchBatch(batch.id);
      if (cancelled || !b) return;
      setBatch(b);
      if (b.finishedAt != null) {
        window.localStorage.removeItem(storageKey);
        const p = await fetchPlan(); // refresh counts now that outputs regenerated
        if (!cancelled && p) setPlan(p);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRun, batch, fetchBatch, fetchPlan, storageKey]);

  const disabledReason = unsaved
    ? "Save your output changes first"
    : !specActive
      ? "Activate this prod spec to rerun its styles"
      : plan && plan.toRerun === 0
        ? "Nothing to rerun — every generated style is up to date"
        : null;

  async function runAll() {
    if (!plan || plan.toRerun === 0 || submitting || activeRun || disabledReason) return;
    const ok = window.confirm(
      `Rerun ${plan.toRerun} style${plan.toRerun === 1 ? "" : "s"} on this prod spec?\n\n` +
        `Regenerates ${plan.withRejected} with rejected output${plan.withRejected === 1 ? "" : "s"} ` +
        `and ${plan.withMissing} with new/missing output${plan.withMissing === 1 ? "" : "s"}. ` +
        `Renders in the background — safe to leave this page.`,
    );
    if (!ok) return;
    setSubmitting(true);
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
        const p = await fetchPlan();
        if (p) setPlan(p);
        return;
      }
      window.localStorage.setItem(storageKey, data.batchId);
      const b = await fetchBatch(data.batchId);
      if (b) setBatch(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  // In-flight: the progress card replaces the button (one run at a time).
  if (activeRun && batch) {
    const pct = batch.total > 0 ? Math.min(100, Math.round((batch.done / batch.total) * 100)) : 0;
    return (
      <div className="mt-4 rounded-md border border-zinc-200 bg-white px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-700">
            <Spinner />
            <span className="font-medium">Rerunning styles</span>
            <span className="tabular-nums text-zinc-500">
              {batch.done}/{batch.total}
            </span>
            {batch.failed > 0 && <span className="tabular-nums text-red-600">· {batch.failed} failed</span>}
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

  const justFinished = batch != null && batch.finishedAt != null && !dismissed;

  return (
    <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800">Rerun all styles</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Regenerate this spec&apos;s already-generated styles after swapping outputs — only the
            outputs that are <span className="font-medium text-zinc-700">new/missing</span> or{" "}
            <span className="font-medium text-zinc-700">rejected</span> (approved work is left alone).
          </p>
        </div>
        <button
          type="button"
          onClick={runAll}
          disabled={submitting || planLoading || plan == null || plan.toRerun === 0 || Boolean(disabledReason)}
          title={disabledReason ?? "Enqueue a scoped rerun for every affected style on this prod spec"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          <RunAllIcon />
          {submitting ? "Starting…" : `Rerun ${plan?.toRerun ?? 0} style${plan?.toRerun === 1 ? "" : "s"}`}
        </button>
      </div>

      {/* Breakdown + affected-styles list so the operator can SEE what runs. */}
      {plan && plan.generatedStyles > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600">
          <span className="inline-flex items-center gap-1">
            <Dot className="bg-red-500" /> {plan.withRejected} with rejected
          </span>
          <span className="inline-flex items-center gap-1">
            <Dot className="bg-amber-500" /> {plan.withMissing} with new/missing
          </span>
          <span className="text-zinc-400">· {plan.generatedStyles} generated styles on this spec</span>
          {plan.sample.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSample((s) => !s)}
              className="text-zinc-500 underline hover:text-zinc-800"
            >
              {showSample ? "Hide" : "See affected styles"}
            </button>
          )}
        </div>
      )}

      {showSample && plan && plan.sample.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-auto rounded-md border border-zinc-200 bg-white">
          {plan.sample.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs last:border-b-0"
            >
              <span className="truncate text-zinc-700">{s.name}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {s.rejected > 0 && (
                  <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                    {s.rejected} rejected
                  </span>
                )}
                {s.missing > 0 && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    {s.missing} new
                  </span>
                )}
              </span>
            </li>
          ))}
          {plan.toRerun > plan.sample.length && (
            <li className="px-3 py-1.5 text-[11px] text-zinc-400">
              and {plan.toRerun - plan.sample.length} more…
            </li>
          )}
        </ul>
      )}

      {disabledReason && plan && plan.toRerun > 0 && (
        <p className="mt-2 text-[11px] text-amber-700">{disabledReason}.</p>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
          {error}
        </p>
      )}

      {justFinished && batch && (
        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
          <span>
            ✓ Rerun complete · {batch.done}/{batch.total}
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
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} aria-hidden="true" />;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 shrink-0 animate-spin text-zinc-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function RunAllIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
