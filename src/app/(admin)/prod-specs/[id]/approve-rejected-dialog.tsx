"use client";

// Confirmation dialog for the ProdSpec header's "Fully approved" toggle.
// Turning the toggle ON (Not approved → Fully approved) opens this instead of
// flipping straight away: it lists the PDFs currently REJECTED on this spec's
// styles and asks the operator to confirm before re-running + auto-approving
// them (and marking the spec fully approved so FUTURE runs auto-approve too).
//
// Confirm path: POST approve-rejected sets the flag + enqueues a rejected-only
// rerun; the runner auto-approves the fresh print-safe PDFs (spec-level gate in
// lib/queue/runner.ts). Progress polls the generic rerun-styles?batchId endpoint.

import { useCallback, useEffect, useState } from "react";

type RejectedStyle = {
  id: string;
  name: string;
  poNumber: string | null;
  rejected: number;
  rejectedNames: string[];
};

type RejectedList = {
  active: boolean;
  rejectedStyles: number;
  rejectedOutputs: number;
  styles: RejectedStyle[];
  capped: boolean;
};

type ConfirmResult = {
  ok: true;
  fullyApproved: boolean;
  inactive: boolean;
  batchId: string | null;
  enqueued: number;
  rejectedStyles: number;
  rejectedOutputs: number;
};

type Batch = {
  id: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  finishedAt: string | null;
};

const POLL_MS = 2000;

// Mounted by the parent only while the dialog is open (a fresh mount per open
// gives clean initial state — no synchronous reset effects needed).
export function ApproveRejectedDialog({
  prodSpecId,
  onClose,
  onConfirmed,
}: {
  prodSpecId: string;
  // Hide the dialog (cancel, or close after confirming). Does NOT change the
  // toggle — the parent only marks the spec approved via onConfirmed.
  onClose: () => void;
  // Fired once the POST succeeds — the parent flips its `fullyApproved` state
  // so the header toggle reflects the now-persisted flag.
  onConfirmed: () => void;
}) {
  const base = `/api/admin/prod-specs/${prodSpecId}/approve-rejected`;

  const [list, setList] = useState<RejectedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);

  const fetchBatch = useCallback(
    async (id: string): Promise<Batch | null> => {
      try {
        const res = await fetch(
          `/api/admin/prod-specs/${prodSpecId}/rerun-styles?batchId=${encodeURIComponent(id)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { batch: Batch | null };
        return data.batch;
      } catch {
        return null;
      }
    },
    [prodSpecId],
  );

  // Load the rejected-PDF list on mount. All setState runs AFTER an await (the
  // codebase forbids synchronous setState in an effect); initial state already
  // reflects "loading", so no pre-reset is needed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as RejectedList;
        if (!cancelled) setList(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load rejected PDFs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  // Escape closes (unless a run is in flight — let it settle first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  // Poll the enqueued batch until it finishes so the dialog can show progress.
  useEffect(() => {
    if (!batch || batch.finishedAt != null) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      const b = await fetchBatch(batch.id);
      if (cancelled || !b) return;
      setBatch(b);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [batch, fetchBatch]);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(base, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Partial<ConfirmResult> & { error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const confirmed = data as ConfirmResult;
      setResult(confirmed);
      onConfirmed(); // flag is persisted server-side — reflect it in the toggle
      if (confirmed.batchId) {
        const b = await fetchBatch(confirmed.batchId);
        if (b) setBatch(b);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const rejectedOutputs = list?.rejectedOutputs ?? 0;
  const rejectedStyles = list?.rejectedStyles ?? 0;
  const hasRejected = rejectedOutputs > 0;
  const inactive = list?.active === false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10"
      onClick={() => {
        if (!submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Approve rejected PDFs"
    >
      <div
        className="flex w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            {result ? "Fully approved" : "Approve rejected PDFs"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4">
          {/* ---- Result / progress state (after confirm) ---- */}
          {result ? (
            <ResultPanel result={result} batch={batch} />
          ) : loading ? (
            <p className="text-sm text-zinc-500">Checking for rejected PDFs…</p>
          ) : error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : hasRejected ? (
            <>
              <p className="text-sm text-zinc-700">
                Do you want to approve the following{" "}
                <span className="font-semibold">
                  {rejectedOutputs} PDF{rejectedOutputs === 1 ? "" : "s"}
                </span>{" "}
                across {rejectedStyles} style{rejectedStyles === 1 ? "" : "s"}? They&apos;ll be
                re-run and auto-approved, and this spec is marked{" "}
                <span className="font-semibold">Fully approved</span> so future runs auto-approve
                too.
              </p>
              {inactive && <InactiveWarning />}
              <ul className="mt-3 max-h-72 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200">
                {list!.styles.map((s) => (
                  <li key={s.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-zinc-800">{s.name}</span>
                      {s.poNumber && (
                        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                          PO {s.poNumber}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.rejectedNames.map((n, i) => (
                        <span
                          key={i}
                          className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {list!.capped && (
                <p className="mt-2 text-xs text-zinc-400">
                  Showing the first {list!.styles.length} styles — more will also be re-run.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-700">
                No rejected PDFs on this spec right now. Marking it{" "}
                <span className="font-semibold">Fully approved</span> will auto-approve future
                print-safe generations.
              </p>
              {inactive && <InactiveWarning />}
            </>
          )}
        </div>

        {/* ---- Footer actions ---- */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-md border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={submitting || loading || (!!error && !list)}
                className="rounded-md bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {submitting
                  ? "Working…"
                  : hasRejected
                    ? `Approve & re-run${rejectedOutputs > 0 ? ` ${rejectedOutputs}` : ""}`
                    : "Mark fully approved"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InactiveWarning() {
  return (
    <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      This spec is <span className="font-semibold">inactive</span>, so nothing can generate yet. The
      flag will be set, but the rejected PDFs won&apos;t re-run until you activate the spec and
      re-run it.
    </p>
  );
}

function ResultPanel({ result, batch }: { result: ConfirmResult; batch: Batch | null }) {
  if (result.inactive) {
    return (
      <p className="text-sm text-zinc-700">
        Marked <span className="font-semibold">Fully approved</span>. The spec is inactive, so the{" "}
        {result.rejectedOutputs} rejected PDF{result.rejectedOutputs === 1 ? "" : "s"} will re-run
        and auto-approve once you activate the spec and re-run it.
      </p>
    );
  }
  if (result.batchId == null || result.enqueued === 0) {
    return (
      <p className="text-sm text-zinc-700">
        Marked <span className="font-semibold">Fully approved</span>. There was nothing to re-run —
        future print-safe generations will auto-approve.
      </p>
    );
  }
  const total = batch?.total ?? result.enqueued;
  const done = batch?.done ?? 0;
  const finished = batch?.finishedAt != null;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div>
      <p className="text-sm text-zinc-700">
        {finished ? "Re-ran" : "Re-running"}{" "}
        <span className="font-semibold">
          {result.rejectedOutputs} PDF{result.rejectedOutputs === 1 ? "" : "s"}
        </span>{" "}
        across {result.enqueued} style{result.enqueued === 1 ? "" : "s"}. Fresh print-safe PDFs
        auto-approve as they finish — safe to close this and leave the page.
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
        <span className="tabular-nums">
          {done}/{total} styles
        </span>
        {batch && batch.failed > 0 && (
          <span className="tabular-nums text-red-600">· {batch.failed} failed</span>
        )}
        {finished && <span className="text-emerald-600">· done</span>}
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
