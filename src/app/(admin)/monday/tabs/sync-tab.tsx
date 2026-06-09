"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatDate } from "@/lib/utils";

type DomainKind = "customers" | "suppliers" | "business-areas" | "styles" | "all";

// Map the client-side kebab kind to the SyncJob enum value used by
// /api/admin/sync/progress.
const DOMAIN_ENUM_KIND: Record<DomainKind, "CUSTOMERS" | "SUPPLIERS" | "BUSINESS_AREAS" | "STYLES" | "ALL"> = {
  customers: "CUSTOMERS",
  suppliers: "SUPPLIERS",
  "business-areas": "BUSINESS_AREAS",
  styles: "STYLES",
  all: "ALL",
};

// Progress shape returned by the polling endpoint. Same fields as the
// recent-runs table; we render it as a live progress bar while a Fill
// is in flight.
type FillProgress = {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | string;
  itemsTotal: number;
  itemsSynced: number;
  itemsFailed: number;
  itemsSkipped: number;
  startedAt: string;
  finishedAt: string | null;
};

const DOMAIN_KINDS: Array<{ kind: DomainKind; label: string; hint: string }> = [
  { kind: "customers", label: "Customers", hint: "Board 3317892788 — Account / Country / Priority." },
  { kind: "suppliers", label: "Suppliers", hint: "Board 3363275451 — Purchaser / Address / Folder." },
  {
    kind: "business-areas",
    label: "Business areas",
    hint: "Dropdown values + values seen in Styles.",
  },
  { kind: "styles", label: "Styles", hint: "Board 7322835224 (Pre Order) — ingests each item into a Style." },
  {
    kind: "all",
    label: "All (in order)",
    hint: "Customers → Suppliers → BAs → Styles → auto-create prod specs.",
  },
];

type KnownBoard = { key: string; id: string; label: string };

type GhostBoardRow = {
  id: string;
  mondayBoardId: string;
  name: string;
  label: string | null;
  itemCount: number;
  lastSyncedAt: Date | null;
};

type SyncJobRow = {
  id: string;
  kind: string;
  status: string;
  itemsTotal: number;
  itemsSynced: number;
  itemsFailed: number;
  // Items that didn't error but couldn't be auto-classified (e.g.
  // ambiguous customer name). Surface separately from itemsFailed so
  // operators don't read "broken" for what's actually "needs review".
  itemsSkipped: number;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  error: string | null;
};

export function SyncTab({
  recent,
  counts,
  ghostBoards,
  knownBoards,
}: {
  recent: SyncJobRow[];
  counts: { customers: number; suppliers: number; businessAreas: number; styles: number };
  ghostBoards: GhostBoardRow[];
  knownBoards: KnownBoard[];
}) {
  const router = useRouter();
  const [domainPending, setDomainPending] = useState<DomainKind | null>(null);
  const [domainResults, setDomainResults] = useState<Record<string, string>>({});
  const [domainProgress, setDomainProgress] = useState<Record<string, FillProgress>>({});
  const [ghostPending, setGhostPending] = useState<string | null>(null);
  const [ghostResults, setGhostResults] = useState<Record<string, string>>({});
  const [sinkAllProgress, setSinkAllProgress] = useState<FillProgress | null>(null);
  const sinkAllStartedAtRef = useRef<number>(0);

  // Per-run starting timestamp so the poller ignores ANY stale SyncJob
  // that pre-dates the current click (sync-all has multiple children;
  // an earlier STYLES run could still be the most-recent row for the
  // brief gap between clicking and the new SyncJob landing).
  const pollStartedAtRef = useRef<Record<string, number>>({});

  // Poll /api/admin/sync/progress while a Fill is in flight. For "all"
  // we follow STYLES specifically since it's by far the longest leg.
  useEffect(() => {
    if (!domainPending) return;
    const captured = domainPending; // closure-stable
    const enumKind =
      captured === "all" ? "STYLES" : DOMAIN_ENUM_KIND[captured];
    const startedAt = pollStartedAtRef.current[captured] ?? Date.now();
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch(
          `/api/admin/sync/progress?kind=${enumKind}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { job: FillProgress | null };
        if (cancelled || !body.job) return;
        const job = body.job;
        // Always show RUNNING jobs (they're the one we just kicked off
        // unless somehow stuck). Only ignore COMPLETED/FAILED jobs that
        // finished BEFORE our click — those are leftovers from a prior
        // run. Wide margin (10 s) tolerates client/server clock skew.
        if (job.status !== "RUNNING") {
          const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
          if (finishedAt && finishedAt < startedAt - 10_000) return;
        }
        setDomainProgress((p) => ({ ...p, [captured]: job }));
      } catch {
        // Silent — the poller is best-effort.
      }
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [domainPending]);

  async function runDomain(kind: DomainKind) {
    setDomainPending(kind);
    setDomainResults((r) => ({ ...r, [kind]: "running…" }));
    pollStartedAtRef.current[kind] = Date.now();
    // Clear any prior progress for this kind so a fresh poll replaces it.
    setDomainProgress((p) => {
      const copy = { ...p };
      delete copy[kind];
      return copy;
    });
    try {
      const res = await fetch(`/api/cron/sync-${kind}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDomainResults((r) => ({ ...r, [kind]: `error: ${body.error ?? res.status}` }));
        return;
      }
      const summary =
        kind === "all"
          ? `done · customers ${body.customers?.itemsSynced ?? 0}, suppliers ${body.suppliers?.itemsSynced ?? 0}, BAs ${body.businessAreas?.itemsSynced ?? 0}, styles ${body.styles?.itemsSynced ?? 0}, +${body.prodSpecsCreated ?? 0} prod specs`
          : `done · ${body.itemsSynced ?? 0}/${body.itemsTotal ?? 0}${body.itemsSkipped ? ` (${body.itemsSkipped} skipped)` : ""}${body.itemsFailed ? ` (${body.itemsFailed} failed)` : ""}`;
      setDomainResults((r) => ({ ...r, [kind]: summary }));
      router.refresh();
    } catch (err) {
      setDomainResults((r) => ({ ...r, [kind]: `error: ${(err as Error).message}` }));
    } finally {
      setDomainPending(null);
    }
  }

  async function runGhost(boardId: string, key: string) {
    setGhostPending(key);
    setGhostResults((r) => ({ ...r, [key]: "running…" }));
    try {
      const res = await fetch(
        `/api/admin/monday/sink?boardId=${encodeURIComponent(boardId)}`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGhostResults((r) => ({ ...r, [key]: `error: ${body.error ?? res.status}` }));
        return;
      }
      setGhostResults((r) => ({
        ...r,
        [key]: `done · ${body.itemsSynced}/${body.itemsTotal} items, ${body.columnsSynced} cols, ${body.dropdownOptionsSynced} options (${Math.round(body.durationMs / 100) / 10}s)`,
      }));
      router.refresh();
    } catch (err) {
      setGhostResults((r) => ({ ...r, [key]: `error: ${(err as Error).message}` }));
    } finally {
      setGhostPending(null);
    }
  }

  async function runGhostAll() {
    setGhostPending("__all__");
    setGhostResults((r) => ({ ...r, __all__: "running…" }));
    sinkAllStartedAtRef.current = Date.now();
    setSinkAllProgress(null);
    try {
      const res = await fetch(`/api/admin/monday/sink-all`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGhostResults((r) => ({ ...r, __all__: `error: ${body.error ?? res.status}` }));
        return;
      }
      const ok = (body.results ?? []).length;
      const failed = (body.failed ?? []).length;
      setGhostResults((r) => ({
        ...r,
        __all__: `done · ${ok} synced, ${failed} failed`,
      }));
      router.refresh();
    } catch (err) {
      setGhostResults((r) => ({ ...r, __all__: `error: ${(err as Error).message}` }));
    } finally {
      setGhostPending(null);
    }
  }

  // Poll the SINK_ALL SyncJob row while "Sync all" is running so we can
  // render the same progress-bar UI Fill uses. ETA math kicks in once
  // at least one board is done; before that it's an indeterminate bar.
  useEffect(() => {
    if (ghostPending !== "__all__") return;
    const startedAt = sinkAllStartedAtRef.current;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(
          `/api/admin/sync/progress?kind=SINK_ALL`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { job: FillProgress | null };
        if (cancelled || !body.job) return;
        const job = body.job;
        if (job.status !== "RUNNING") {
          const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
          if (finishedAt && finishedAt < startedAt - 10_000) return;
        }
        setSinkAllProgress(job);
      } catch {
        // Silent.
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ghostPending]);

  return (
    <div className="flex flex-col gap-8">
      {/* ──────── Sync (raw API snapshot → ghost DB) ──────── */}
      <section>
        <div className="mb-2 flex items-end justify-between">
          <div>
            <h2 className="text-base font-semibold">Sync</h2>
            <p className="text-sm text-zinc-500">
              Raw API snapshot — pulls each board&apos;s columns, items, and dropdown options into the
              ghost tables. Idempotent; safe to re-run. Source for the{" "}
              <a href="/monday?tab=data" className="underline">
                Data tab
              </a>
              .
            </p>
          </div>
          <button
            type="button"
            onClick={runGhostAll}
            disabled={ghostPending !== null}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {ghostPending === "__all__" ? "Running…" : "Sync all"}
          </button>
        </div>
        {ghostPending === "__all__" ? (
          <div className="mb-3">
            <FillProgressBar
              progress={sinkAllProgress ?? undefined}
              startedAt={sinkAllStartedAtRef.current}
              unit="boards"
            />
          </div>
        ) : (
          <div className="mb-3 text-xs text-zinc-600">{ghostResults.__all__ ?? "—"}</div>
        )}
        <ul className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {knownBoards.map((b) => {
            const ghost = ghostBoards.find((g) => g.mondayBoardId === b.id);
            return (
              <li
                key={b.key}
                className="flex items-center gap-4 border-t border-zinc-100 px-4 py-3 first:border-t-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{b.label}</div>
                  <div className="text-xs text-zinc-500">
                    <span className="font-mono">{b.id}</span>
                    {ghost ? (
                      <>
                        {" · "}
                        {ghost.itemCount} items · synced {formatDate(ghost.lastSyncedAt)}
                      </>
                    ) : (
                      <> · never synced</>
                    )}
                  </div>
                </div>
                <div className="w-80 text-right text-xs text-zinc-600 truncate">
                  {ghostResults[b.key] ?? "—"}
                </div>
                <button
                  type="button"
                  onClick={() => runGhost(b.id, b.key)}
                  disabled={ghostPending !== null}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {ghostPending === b.key ? "Running…" : "Sync"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ──────── Fill (ghost → typed domain mirrors) ──────── */}
      <section>
        <div className="mb-2">
          <h2 className="text-base font-semibold">Fill</h2>
          <p className="text-sm text-zinc-500">
            Reads from the ghost tables Sync populated and upserts the typed mirrors
            (Customer / Supplier / BusinessArea / Style). Pure DB → DB — no Monday API
            calls, so safe to re-run as many times as you want. Run Sync first to refresh
            the ghost from Monday; Fill processes whatever&apos;s there.
          </p>
        </div>
        <div className="mb-4 grid grid-cols-4 gap-3">
          <Stat label="Customers (active)" value={counts.customers} />
          <Stat label="Suppliers (active)" value={counts.suppliers} />
          <Stat label="Business areas (active)" value={counts.businessAreas} />
          <Stat label="Styles" value={counts.styles} />
        </div>
        <ul className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {DOMAIN_KINDS.map(({ kind, label, hint }) => {
            const prog = domainProgress[kind];
            const isPending = domainPending === kind;
            return (
              <li
                key={kind}
                className="flex flex-col gap-2 border-t border-zinc-100 px-4 py-3 first:border-t-0"
              >
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-zinc-500">{hint}</div>
                  </div>
                  <div className="w-72 text-right text-xs text-zinc-600 truncate">
                    {!isPending ? (domainResults[kind] ?? "—") : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => runDomain(kind)}
                    disabled={domainPending !== null}
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {isPending ? "Running…" : "Fill"}
                  </button>
                </div>
                {isPending && (
                  <FillProgressBar progress={prog} startedAt={pollStartedAtRef.current[kind]} kind={kind} />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ──────── Recent runs ──────── */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Recent Fill runs ({recent.length})
        </header>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Kind</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Total</th>
              <th className="px-4 py-2">Synced</th>
              <th className="px-4 py-2">Skipped</th>
              <th className="px-4 py-2">Failed</th>
              <th className="px-4 py-2">Started</th>
              <th className="px-4 py-2">Finished</th>
              <th className="px-4 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-zinc-500">
                  No sync runs yet. Click a button above to bootstrap mirrors.
                </td>
              </tr>
            ) : (
              recent.map((j) => (
                <tr key={j.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2 font-mono text-xs">{j.kind}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        j.status === "COMPLETED"
                          ? "bg-emerald-100 text-emerald-800"
                          : j.status === "RUNNING"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-red-100 text-red-800"
                      }`}
                    >
                      {j.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums text-zinc-600">{j.itemsTotal}</td>
                  <td className="px-4 py-2 tabular-nums text-zinc-600">{j.itemsSynced}</td>
                  <td
                    className="px-4 py-2 tabular-nums text-amber-700"
                    title="Items not promoted because they need operator action (e.g. ambiguous customer). Surface in /import."
                  >
                    {j.itemsSkipped}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-zinc-600">{j.itemsFailed}</td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{formatDate(j.startedAt)}</td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{formatDate(j.finishedAt)}</td>
                  <td className="px-4 py-2 text-xs text-red-700">
                    {j.error ? <span title={j.error}>{j.error.slice(0, 80)}</span> : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Inline progress bar shown under a Fill row (or Sync-All header) while
// it's running. Driven by the /api/admin/sync/progress poll; updates
// roughly every second. We show absolute counts + ETA (extrapolated
// from items-per-second since the run started). For Sync All the unit
// is "boards" (1/4, 2/4, …); for Fill it's "items".
function FillProgressBar({
  progress,
  startedAt,
  unit = "items",
  kind,
}: {
  progress: FillProgress | undefined;
  startedAt: number | undefined;
  unit?: "items" | "boards";
  kind?: DomainKind;
}) {
  // Tick a clock in state so the "Xs elapsed / ~Ys left" string updates
  // every second between server polls. Reading Date.now() during render
  // would be impure (lint rule); storing it in state is the supported
  // way to "render the current time".
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Before the first poll lands we have no data — show indeterminate.
  if (!progress || progress.itemsTotal === 0) {
    return (
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
          <div className="h-full w-full animate-pulse rounded-full bg-zinc-300" />
        </div>
        <span className="tabular-nums">starting…</span>
      </div>
    );
  }

  const done = progress.itemsSynced + progress.itemsFailed + progress.itemsSkipped;
  const pct = Math.min(100, Math.round((done / progress.itemsTotal) * 100));
  const elapsedMs = startedAt ? now - startedAt : 0;
  const rate = done > 0 && elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
  const remaining = progress.itemsTotal - done;
  const etaSec = rate > 0 ? Math.ceil(remaining / rate) : null;
  const elapsedSec = Math.floor(elapsedMs / 1000);

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full rounded-full bg-zinc-900 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-44 text-right tabular-nums text-zinc-600">
        {done}/{progress.itemsTotal} {unit} · {pct}%
      </span>
      <span className="w-32 text-right tabular-nums text-zinc-500">
        {formatDuration(elapsedSec)} elapsed
        {etaSec !== null && remaining > 0 && ` · ~${formatDuration(etaSec)} left`}
      </span>
      {(progress.itemsFailed > 0 || progress.itemsSkipped > 0) && (
        <span
          className="text-zinc-500"
          title={
            kind === "all"
              ? "Counts below are for the Styles leg (the slowest)."
              : undefined
          }
        >
          {progress.itemsSkipped > 0 && (
            <span className="text-amber-700">{progress.itemsSkipped} skipped </span>
          )}
          {progress.itemsFailed > 0 && (
            <span className="text-red-700">{progress.itemsFailed} failed</span>
          )}
        </span>
      )}
    </div>
  );
}

function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}
