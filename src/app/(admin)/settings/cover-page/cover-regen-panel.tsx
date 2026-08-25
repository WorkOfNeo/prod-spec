"use client";

import { useCallback, useRef, useState } from "react";

// "Regenerate cover pages" — rebuilds the CURRENT cover of every style that
// already has one, so a new cover format or an edit to the global block above
// reaches existing (incl. already-approved) styles without a full re-run. The
// runner only re-renders a cover when a run generates ≥1 output, and a fully-
// approved style settles without rendering — so existing covers are otherwise
// frozen. This drives the chunked sweep endpoint and shows live progress.
//
// Scoped mode (`prodSpecId`) narrows all of that to one Customer × Business
// Area — what the General information tab needs, since that text prints only in
// its own spec's covers. Same endpoint, same confirm, same idempotence; only
// the prepared id list differs.

type Phase = "idle" | "preparing" | "confirm" | "running" | "done" | "error";

type Props = {
  // Omitted ⇒ sweep the whole estate (the global cover block's blast radius).
  prodSpecId?: string;
  // Noun phrase for the scope, used in the panel copy, e.g. "this prod spec".
  scopeLabel?: string;
};

// Styles rendered per request. Small so each POST finishes well inside the
// route's maxDuration; the client loops until the id list is drained.
const CHUNK = 5;

type Prepared = { styleIds: string[]; total: number; delivered: number };

type Totals = {
  processed: number;
  refreshed: number;
  noCover: number;
  skippedApproved: number;
  skippedUnchanged: number;
  errors: number;
  requeued: number;
  pushed: number;
  pushErrors: number;
};

const ZERO: Totals = {
  processed: 0,
  refreshed: 0,
  noCover: 0,
  skippedApproved: 0,
  skippedUnchanged: 0,
  errors: 0,
  requeued: 0,
  pushed: 0,
  pushErrors: 0,
};

export function CoverRegenPanel({ prodSpecId, scopeLabel }: Props = {}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [deliver, setDeliver] = useState(true);
  // Default ON: an all-approved style's manifest prints no status wording, so
  // rebuilding it is a visual no-op that still overwrites the supplier's copy
  // for a finished order.
  const [onlyPending, setOnlyPending] = useState(true);
  // Default ON: rebuilding a cover whose manifest is already current overwrites
  // a supplier's file to change nothing. Also what makes a stopped run resumable.
  const [onlyChanged, setOnlyChanged] = useState(true);
  // Default OFF, and deliberately the opposite of `deliver`. A sweep spans
  // hundreds of orders whose suppliers have nothing new to act on; the file
  // belongs in their folder, an email about it does not.
  const [notifySupplier, setNotifySupplier] = useState(false);
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [error, setError] = useState<string | null>(null);
  // Set by "Stop" — the run loop checks it between chunks and bails cleanly.
  const stopRef = useRef(false);

  const prepare = useCallback(async () => {
    setPhase("preparing");
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/cover-page/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "prepare", ...(prodSpecId ? { prodSpecId } : {}) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
      const data = (await res.json()) as Prepared;
      setPrepared(data);
      setPhase(data.total === 0 ? "done" : "confirm");
      setTotals(ZERO);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to prepare");
      setPhase("error");
    }
  }, [prodSpecId]);

  const run = useCallback(async () => {
    if (!prepared) return;
    stopRef.current = false;
    setPhase("running");
    setError(null);
    const acc: Totals = { ...ZERO };
    setTotals(acc);

    for (let i = 0; i < prepared.styleIds.length; i += CHUNK) {
      if (stopRef.current) break;
      const chunk = prepared.styleIds.slice(i, i + CHUNK);
      try {
        const res = await fetch("/api/admin/settings/cover-page/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "process",
            styleIds: chunk,
            deliver,
            onlyPending,
            onlyChanged,
            notifySupplier,
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Failed (${res.status})`);
        const data = (await res.json()) as Omit<Totals, "processed"> & { errors: number };
        acc.refreshed += data.refreshed;
        acc.noCover += data.noCover;
        acc.skippedApproved += data.skippedApproved;
        acc.skippedUnchanged += data.skippedUnchanged ?? 0;
        acc.errors += data.errors;
        acc.requeued += data.requeued;
        acc.pushed += data.pushed;
        acc.pushErrors += data.pushErrors;
      } catch (e) {
        // A whole-chunk failure (network / timeout) — count the chunk as errored
        // and keep going; the sweep is idempotent, so a later re-run retries.
        acc.errors += chunk.length;
        console.warn("[cover-regen] chunk failed:", e);
      }
      acc.processed += chunk.length;
      setTotals({ ...acc });
    }
    setPhase("done");
  }, [prepared, deliver, onlyPending, onlyChanged, notifySupplier]);

  const stop = useCallback(() => {
    stopRef.current = true;
  }, []);

  // NB: a prepared id list belongs to the scope it was prepared for. Callers
  // that can change `prodSpecId` must remount this panel (React `key`) so a
  // stale list can't be "Start"ed against a different prod spec — the General
  // information tab does that by keying its whole per-spec subtree.
  const total = prepared?.total ?? 0;
  const pct = total > 0 ? Math.round((totals.processed / total) * 100) : 0;
  const scoped = Boolean(prodSpecId);
  const scopeNoun = scopeLabel ?? "this prod spec";

  return (
    <div className="mt-10 rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">
            {scoped ? "Apply to existing bundles" : "Regenerate cover pages"}
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
            {scoped ? (
              <>
                Your edit already applies to everything generated from now on. This rebuilds the
                cover PDF of styles under <strong>{scopeNoun}</strong> that were generated
                <em> before</em> it, so they pick up the new text. Styles whose outputs are all
                approved are skipped by default — you can include them at the confirm step. Outputs
                are not re-rendered and approvals are untouched. Delivered styles get the updated
                cover pushed to their supplier&apos;s SharePoint folder; whether the suppliers are
                also emailed about it is a choice at the confirm step, and it is off by default.
              </>
            ) : (
              <>
                Rebuilds the cover PDF of every style that already has one, so the current cover
                format and the block above take effect on existing styles. Styles whose outputs are
                all approved are skipped by default. Outputs are not re-rendered and approvals are
                untouched. Delivered styles get the updated cover pushed to their supplier&apos;s
                SharePoint folder; whether the suppliers are also emailed about it is a choice at
                the confirm step, and it is off by default. To see what would change before running
                anything, use the preview above.
              </>
            )}
          </p>
        </div>
        {phase === "idle" && (
          <button
            type="button"
            onClick={prepare}
            className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            {scoped ? "Apply to existing bundles" : "Regenerate all cover pages"}
          </button>
        )}
        {phase === "preparing" && (
          <span className="shrink-0 py-2 text-sm text-zinc-400">Counting styles…</span>
        )}
      </div>

      {phase === "error" && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          <button type="button" onClick={() => setPhase("idle")} className="ml-3 underline">
            Try again
          </button>
        </div>
      )}

      {phase === "confirm" && prepared && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            This will rebuild <strong>{prepared.total}</strong> cover page
            {prepared.total === 1 ? "" : "s"}.
          </p>
          <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
            <input
              type="checkbox"
              checked={onlyPending}
              onChange={(e) => setOnlyPending(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Skip styles where every output is approved. Their manifest shows no
              status column at all, so rebuilding changes nothing a supplier can see — but it
              still overwrites the cover in the folder for an order that&rsquo;s already finished.
              Uncheck only if you changed something that shows on every cover.
            </span>
          </label>
          <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
            <input
              type="checkbox"
              checked={deliver}
              onChange={(e) => setDeliver(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Push updated covers to suppliers — up to <strong>{prepared.delivered}</strong> delivered
              style{prepared.delivered === 1 ? "" : "s"} will have the new cover re-pushed to
              SharePoint and re-notified on the next nightly supplier digest. Uncheck to only refresh
              the covers in-app.
            </span>
          </label>
          <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(e) => setOnlyChanged(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Skip covers that already say the right thing. Each rebuild records what it printed, so
              a second run costs nothing and a stopped run resumes where it left off. Unchecking
              this re-uploads every cover in the list whether or not it reads differently.
            </span>
          </label>
          <label className="mt-3 flex items-start gap-2 text-[13px] text-amber-900">
            <input
              type="checkbox"
              checked={notifySupplier}
              onChange={(e) => setNotifySupplier(e.target.checked)}
              className="mt-0.5"
              disabled={!deliver}
            />
            <span>
              <strong>Also email the suppliers</strong> about it in tonight&rsquo;s digest. Off by
              default: the updated file still reaches their folder either way, and a bulk refresh
              across old orders is not something a supplier needs an email about. Tick this only if
              the change is one they must actually read.
            </span>
          </label>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={run}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Start
            </button>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(phase === "running" || phase === "done") && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              {phase === "running" ? "Regenerating…" : "Done"} · {totals.processed}/{total}
            </span>
            {phase === "running" && (
              <button type="button" onClick={stop} className="text-zinc-600 underline">
                Stop
              </button>
            )}
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
            <div
              className={`h-full rounded-full transition-all ${phase === "done" ? "bg-emerald-500" : "bg-zinc-800"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-zinc-600">
            <span>
              Refreshed <strong className="text-zinc-900">{totals.refreshed}</strong>
            </span>
            {deliver && (
              <span>
                Queued for suppliers <strong className="text-zinc-900">{totals.requeued}</strong>
                {notifySupplier ? "" : " · no email"}
              </span>
            )}
            {deliver && (totals.pushed > 0 || totals.pushErrors > 0) && (
              <span>
                Pushed to SharePoint <strong className="text-zinc-900">{totals.pushed}</strong>
                {totals.pushErrors > 0 ? ` · ${totals.pushErrors} failed` : ""}
              </span>
            )}
            {totals.skippedUnchanged > 0 && (
              <span>
                Skipped (already current){" "}
                <strong className="text-zinc-900">{totals.skippedUnchanged}</strong>
              </span>
            )}
            {totals.skippedApproved > 0 && (
              <span>
                Skipped (all approved) <strong className="text-zinc-900">{totals.skippedApproved}</strong>
              </span>
            )}
            {totals.noCover > 0 && <span>No cover yet {totals.noCover}</span>}
            {totals.errors > 0 && (
              <span className="text-red-600">Errors {totals.errors}</span>
            )}
          </div>
          {phase === "done" && (
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setPrepared(null);
                setTotals(ZERO);
              }}
              className="mt-4 rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Close
            </button>
          )}
        </div>
      )}

      {phase === "done" && prepared?.total === 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          {scoped
            ? `No style under ${scopeNoun} has a generated cover yet — nothing to update. New bundles will carry your edit.`
            : "No styles have a generated cover yet — nothing to regenerate."}
        </p>
      )}
    </div>
  );
}
