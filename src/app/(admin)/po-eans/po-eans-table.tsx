"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useUrlSearchState } from "@/lib/use-url-search-state";
import type { EanView } from "@/lib/po/ean-view";
import {
  eanStatusMeta,
  eanFloated,
  FLOATABLE_STATUSES,
  MAX_EAN_ATTEMPTS,
  RECYCLE_MIN_AGE_MS,
  RECYCLE_DAILY_QUOTA,
} from "@/lib/po/ean-status-meta";
import { colorFromVariantLabel } from "@/lib/po/ean-format";
import { PoPdfLink } from "@/components/po-pdf-preview";

// Which slice of the queue the page is showing — driven by the URL
// (?floated=1 / ?status=…) and deep-linked from the /automation chips.
export type PoEanFilter =
  | { kind: "status"; value: string }
  | { kind: "floated" }
  | null;

export type PoEanRow = {
  id: string;
  name: string;
  // Colour code ("*A"/"*B") — disambiguates two colourways sharing a style number.
  colourCode: string;
  poNumber: string;
  supplierName: string | null;
  // Formatted timestamp of the last resolution attempt (null = never).
  resolvedAt: string | null;
  // Consecutive non-resolved scrape attempts. At MAX_EAN_ATTEMPTS the row
  // leaves the fast lane; from there the recycle lane keeps re-checking it on
  // a slow cycle, so this doubles as "times checked".
  eanAttempts: number;
  // Which lane the row is in, resolved server-side (it needs the PO cutoff and
  // the row's position in the recycle queue). "cycling" carries the estimated
  // next check; "parked" means below the cutoff — nothing automatic will run.
  lane:
    | { kind: "active" }
    | { kind: "cycling"; nextCheck: string }
    | { kind: "parked"; cutoff: number };
  // Persisted resolution snapshot rendered on first paint.
  initial: EanView;
};

// Statuses where being below the PO cutoff actually matters — i.e. the row is
// waiting on work that will never come. A resolved row below the cutoff is
// simply done, so flagging it as "parked" would be noise.
const PARKABLE = new Set(["PENDING", "RESOLVING", ...FLOATABLE_STATUSES]);
function parkable(status: string): boolean {
  return PARKABLE.has(status);
}

function StatusBadge({ status }: { status: string }) {
  const m = eanStatusMeta(status);
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function PoEansTable({
  rows,
  counts,
  floatedCount,
  activeFilter,
  scopeQuery = "",
}: {
  rows: PoEanRow[];
  // True per-status totals across all PO styles (not just the loaded rows).
  counts: Record<string, number>;
  // Total rows the sweep has given up on, across all PO styles.
  floatedCount: number;
  activeFilter: PoEanFilter;
  // Current PO-cutoff scope as a query fragment (e.g. "scope=parked"), so the
  // status filters compose with the active/parked view instead of dropping it.
  scopeQuery?: string;
}) {
  // Build a /po-eans href that keeps the current scope. "gave up" is global
  // (triage across scopes), so it never carries the scope.
  const scoped = (extra: string) =>
    `/po-eans${scopeQuery || extra ? "?" : ""}${[scopeQuery, extra].filter(Boolean).join("&")}`;
  // Persisted in the URL (?q=…), alongside the existing ?status / ?floated
  // params, so the free-text search survives back-navigation too.
  const [q, setQ] = useUrlSearchState("q");
  // Per-row override after a manual re-resolve ("loading" while in flight).
  const [overrides, setOverrides] = useState<Record<string, EanView | "loading">>({});
  const [busy, setBusy] = useState(false);
  // Live counter while a batch re-resolve runs.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.colourCode} ${r.poNumber} ${r.supplierName ?? ""}`.toLowerCase().includes(n),
    );
  }, [rows, q]);

  // How many rows the active filter actually has in the DB — when it exceeds
  // the loaded window we tell the user the view is truncated.
  const activeTotal =
    activeFilter == null
      ? null
      : activeFilter.kind === "floated"
        ? floatedCount
        : (counts[activeFilter.value] ?? 0);
  const truncated = activeTotal != null && rows.length < activeTotal;
  const isFloatedView = activeFilter?.kind === "floated";

  async function resolve(id: string) {
    setOverrides((p) => ({ ...p, [id]: "loading" }));
    try {
      const res = await fetch(`/api/admin/styles/${id}/eans`);
      const data = (await res.json()) as EanView;
      setOverrides((p) => ({ ...p, [id]: data }));
    } catch (e) {
      setOverrides((p) => ({
        ...p,
        [id]: {
          status: "ERROR",
          message: e instanceof Error ? e.message : "failed",
          poFileName: null,
          sizeEans: [],
          cartonEan: null,
        },
      }));
    }
  }

  // Re-resolve a set of rows — each is a PDF download + parse, so run a few in
  // parallel and surface a live count rather than freezing on one button.
  async function resolveMany(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: ids.length });
    let i = 0;
    let done = 0;
    const worker = async () => {
      while (i < ids.length) {
        await resolve(ids[i++]);
        done += 1;
        setProgress({ done, total: ids.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProgress(null);
    setBusy(false);
  }

  // Any deliberately-filtered view (a status chip or the floated "gave up"
  // set) is explicit operator intent — drain the whole loaded set, e.g.
  // "Resolved" after a scrape-logic fix to refresh every stored row. Only the
  // unfiltered list keeps the first-20 cap, so the default view can't kick
  // off hundreds of scrapes by accident. Repeat-clicking "first 20" can't
  // drain a set anyway: re-resolved rows float back to the top of the list.
  const drainAll = activeFilter != null;
  function runBulk() {
    const targets = drainAll ? filtered : filtered.slice(0, 20);
    return resolveMany(targets.map((r) => r.id));
  }

  const bulkLabel = progress
    ? `Re-resolving ${progress.done}/${progress.total}…`
    : drainAll
      ? `Re-resolve all (${filtered.length})`
      : "Re-resolve first 20";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search style, PO, or supplier…"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={runBulk}
          disabled={busy || filtered.length === 0}
          className="shrink-0 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {bulkLabel}
        </button>
      </div>

      {/* Clickable filter chips — each narrows the list to that status (or the
          gave-up set) via the URL, so deep links from /automation land here. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {activeFilter && (
          <Link
            href={scoped("")}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
          >
            ← all
          </Link>
        )}
        {floatedCount > 0 && (
          <Link
            href="/po-eans?floated=1"
            aria-pressed={isFloatedView}
            className={`inline-flex items-center gap-1 rounded-full bg-amber-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-500 ${
              isFloatedView ? "ring-2 ring-amber-300 ring-offset-1" : ""
            }`}
            title="Out of fast-lane retries. In-scope rows are re-checked on a slow background cycle; rows below the PO cutoff are parked."
          >
            gave up <span className="tabular-nums">{floatedCount}</span>
          </Link>
        )}
        {Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([status, n]) => {
            const m = eanStatusMeta(status);
            const active = activeFilter?.kind === "status" && activeFilter.value === status;
            return (
              <Link
                key={status}
                href={scoped(`status=${status}`)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium hover:opacity-80 ${m.cls} ${
                  active ? "ring-2 ring-zinc-400 ring-offset-1" : ""
                }`}
              >
                {m.label} <span className="tabular-nums opacity-70">{n}</span>
              </Link>
            );
          })}
      </div>

      {isFloatedView && (
        <div className="mb-3 -mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          These used up their {MAX_EAN_ATTEMPTS} fast-lane retries. Nothing here is abandoned:
          rows <strong>at or above the PO cutoff</strong> are re-checked on a slow background
          cycle — least-recently-checked first, no more often than every{" "}
          {Math.round(RECYCLE_MIN_AGE_MS / (24 * 60 * 60 * 1000))} days, up to{" "}
          {RECYCLE_DAILY_QUOTA}/day — and each row shows its estimated next check. Rows{" "}
          <strong>below the cutoff</strong> are marked <em>parked</em>: no automation will touch
          them, so use Re-resolve if you need one now.
        </div>
      )}

      {truncated && (
        <p className="mb-3 -mt-1 text-xs text-zinc-400">
          Showing the first {rows.length} of {activeTotal}. Narrow with search, or re-resolve in
          batches.
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Style</th>
              <th className="px-4 py-3">PO</th>
              <th className="px-4 py-3">Supplier</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">EANs (size order) + carton</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const ov = overrides[r.id];
              const loading = ov === "loading";
              const view = ov && ov !== "loading" ? ov : r.initial;
              // Only the persisted snapshot can be "floated" — a manual
              // re-resolve (override present) has reset the counter server-side.
              const floated = !ov && eanFloated(r.initial.status, r.eanAttempts);
              return (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="px-4 py-3 font-medium">
                    {r.name}
                    {r.colourCode && (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-normal text-zinc-500">
                        {r.colourCode}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <PoPdfLink styleId={r.id} poNumber={r.poNumber} />
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{r.supplierName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={loading ? "RESOLVING" : view.status} />
                    {!ov && floated && r.lane.kind === "cycling" && (
                      <span className="ml-1 inline-flex rounded-full bg-amber-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                        re-checking · {r.eanAttempts}×
                      </span>
                    )}
                    {/* Below the cutoff nothing automatic runs — say so rather
                        than letting "queued" imply we're getting to it. */}
                    {!ov && r.lane.kind === "parked" && parkable(r.initial.status) && (
                      <span className="ml-1 inline-flex rounded-full bg-zinc-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                        parked{r.eanAttempts > 0 ? ` · ${r.eanAttempts}×` : ""}
                      </span>
                    )}
                    {!ov && (r.resolvedAt || r.lane.kind !== "active") && (
                      <div className="mt-0.5 text-[11px] text-zinc-400">
                        {r.resolvedAt ? `checked ${r.resolvedAt}` : "never checked"}
                        {r.lane.kind === "cycling" && <> · next ~{r.lane.nextCheck}</>}
                        {r.lane.kind === "parked" && parkable(r.initial.status) && (
                          <> · below PO cutoff {r.lane.cutoff} — no auto re-check</>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {loading ? (
                      <span className="text-zinc-400">Resolving…</span>
                    ) : (
                      <ResultCell view={view} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => resolve(r.id)}
                      disabled={loading}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                    >
                      {loading ? "…" : "Re-resolve"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultCell({ view }: { view: EanView }) {
  return (
    <div>
      {view.poFileName && <div className="mb-1 text-xs text-zinc-400">{view.poFileName}</div>}
      {view.sizeEans.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {view.sizeEans.map((s, i) => {
            const color = colorFromVariantLabel(s.variantLabel);
            return (
              <li key={i} className="tabular-nums">
                <span className="text-zinc-500">{s.size}</span>
                {color && <span className="text-zinc-400"> · {color}</span>}{" "}
                <span className={s.ean13 ? "font-medium text-zinc-800" : "text-zinc-300"}>
                  {s.ean13 ?? "— no match"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {view.cartonEan && (
        <div className="mt-1 text-xs tabular-nums text-zinc-500">
          carton <span className="font-medium text-zinc-800">{view.cartonEan}</span>
        </div>
      )}
      {view.sizeEans.length === 0 && !view.message && (
        <span className="text-xs text-zinc-400">—</span>
      )}
      {view.message && <div className="mt-1 text-xs text-zinc-400">{view.message}</div>}
    </div>
  );
}
