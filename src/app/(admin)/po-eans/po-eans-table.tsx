"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EanView } from "@/lib/po/ean-view";
import { eanStatusMeta, eanFloated } from "@/lib/po/ean-status-meta";
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
  poNumber: string;
  supplierName: string | null;
  // Formatted timestamp of the last resolution attempt (null = never).
  resolvedAt: string | null;
  // Consecutive non-resolved scrape attempts; at MAX_EAN_ATTEMPTS the row
  // "floats" (the sweep gives up) and needs a manual Re-resolve.
  eanAttempts: number;
  // Persisted resolution snapshot rendered on first paint.
  initial: EanView;
};

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
  const [q, setQ] = useState("");
  // Per-row override after a manual re-resolve ("loading" while in flight).
  const [overrides, setOverrides] = useState<Record<string, EanView | "loading">>({});
  const [busy, setBusy] = useState(false);
  // Live counter while a batch re-resolve runs.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.poNumber} ${r.supplierName ?? ""}`.toLowerCase().includes(n),
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

  // On the floated view, drain the whole gave-up set; otherwise cap at the
  // first 20 so the unfiltered list can't kick off hundreds of scrapes.
  function runBulk() {
    const targets = isFloatedView ? filtered : filtered.slice(0, 20);
    return resolveMany(targets.map((r) => r.id));
  }

  const bulkLabel = progress
    ? `Re-resolving ${progress.done}/${progress.total}…`
    : isFloatedView
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
            className={`inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-red-500 ${
              isFloatedView ? "ring-2 ring-red-300 ring-offset-1" : ""
            }`}
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
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3">
                    <PoPdfLink styleId={r.id} poNumber={r.poNumber} />
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{r.supplierName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={loading ? "RESOLVING" : view.status} />
                    {floated && (
                      <span className="ml-1 inline-flex rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                        gave up · {r.eanAttempts}×
                      </span>
                    )}
                    {!ov && r.resolvedAt && (
                      <div className="mt-0.5 text-[11px] text-zinc-400">{r.resolvedAt}</div>
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
