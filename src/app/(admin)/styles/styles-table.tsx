"use client";

// Single-input filtered table for /styles. Mirrors prod-specs-table.tsx
// in approach: server-side fetches all rows once, client filters with
// substring match on a pre-built blob (name + customer + BA + PO# +
// status). Trade-off: ~4k rows live in the DOM, but the table is light
// (no per-row interactivity) so browsers handle it fine.

import Link from "next/link";
import { useMemo, useState } from "react";
import { isArchivedGroup } from "@/lib/import/heuristics";
import type { ReadinessTone } from "@/lib/styles/readiness";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import type { EanView } from "@/lib/po/ean-view";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  READY: "bg-emerald-100 text-emerald-800",
  GENERATING: "bg-blue-100 text-blue-800",
  AWAITING_REVIEW: "bg-purple-100 text-purple-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
};

// Attribute presence filters shown as chips next to the search box. Each is
// tri-state: "any" (ignored), "has" (row must HAVE the attribute), "no"
// (row must LACK it). Customer is intentionally absent — every style has a
// required customer FK, so a "Has Customer" filter would never narrow.
type TriState = "any" | "has" | "no";
const NEXT_STATE: Record<TriState, TriState> = { any: "has", has: "no", no: "any" };

const ATTR_FILTERS: ReadonlyArray<{ key: string; label: string; has: (r: StyleRow) => boolean }> = [
  { key: "po", label: "PO", has: (r) => Boolean(r.poNumber && r.poNumber.trim()) },
  { key: "ba", label: "Business area", has: (r) => Boolean(r.businessArea && r.businessArea.trim()) },
  { key: "prodSpec", label: "Prod spec", has: (r) => r.hasProdSpec },
  { key: "supplier", label: "Supplier", has: (r) => r.hasSupplier },
];

export type StyleRow = {
  id: string;
  name: string;
  poNumber: string | null;
  customerName: string;
  businessArea: string | null;
  completionPct: number;
  // % of required columns this style must reach before it can generate.
  // From the linked ProdSpec; null when no ProdSpec is linked.
  threshold: number | null;
  hasProdSpec: boolean;
  hasSupplier: boolean;
  // Required detail fields filled / total (Settings ▸ Required fields).
  // requiredTotal 0 = none configured.
  requiredFilled: number;
  requiredTotal: number;
  // "Will it generate?" verdict — tone + chip label + hover hint.
  readiness: { tone: ReadinessTone; label: string; hint: string };
  status: string;
  // PO → EAN resolution state (StyleEanStatus). Badge via eanStatusMeta.
  eanStatus: string;
  groupTitle: string | null;
  lastSyncedAt: string;
  searchBlob: string;
};

export function StylesTable({
  rows,
  autoGenerateEnabled,
}: {
  rows: StyleRow[];
  autoGenerateEnabled: boolean;
}) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Per-attribute tri-state presence filters (keyed by ATTR_FILTERS.key).
  const [attrFilters, setAttrFilters] = useState<Record<string, TriState>>({});

  const cycleAttr = (key: string) =>
    setAttrFilters((p) => ({ ...p, [key]: NEXT_STATE[p[key] ?? "any"] }));
  const activeAttrFilters = ATTR_FILTERS.filter((a) => (attrFilters[a.key] ?? "any") !== "any");
  // Per-row live EAN resolve results (manual "Resolve" button). A row's
  // freshly-resolved view overrides its stored eanStatus badge in-place.
  const [eanResults, setEanResults] = useState<Record<string, EanView | "loading">>({});

  async function resolveEans(id: string) {
    setEanResults((p) => ({ ...p, [id]: "loading" }));
    try {
      const res = await fetch(`/api/admin/styles/${id}/eans`);
      const data = (await res.json()) as EanView;
      setEanResults((p) => ({ ...p, [id]: data }));
    } catch (e) {
      setEanResults((p) => ({
        ...p,
        [id]: {
          status: "ERROR",
          message: e instanceof Error ? e.message : "request failed",
          poFileName: null,
          sizeEans: [],
          cartonEan: null,
        },
      }));
    }
  }

  // Pre-compute archived flag once so the filter loop is cheap.
  const archivedFlags = useMemo(
    () => rows.map((r) => isArchivedGroup(r.groupTitle)),
    [rows],
  );
  const archivedCount = useMemo(
    () => archivedFlags.filter(Boolean).length,
    [archivedFlags],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r, i) => {
      if (!showArchived && archivedFlags[i]) return false;
      // Attribute presence filters (AND across all active chips).
      for (const a of activeAttrFilters) {
        const want = attrFilters[a.key];
        const has = a.has(r);
        if (want === "has" && !has) return false;
        if (want === "no" && has) return false;
      }
      if (!needle) return true;
      return r.searchBlob.includes(needle);
    });
  }, [rows, q, showArchived, archivedFlags, attrFilters, activeAttrFilters]);

  return (
    <div>
      {!autoGenerateEnabled && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Automatic generation is <strong>OFF</strong> — complete styles won&rsquo;t generate on
          sync until it&rsquo;s switched on in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </div>
      )}
      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, customer, business area, PO#, or status…"
            className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
          {archivedCount > 0 && (
            <span className="tabular-nums text-zinc-400">({archivedCount})</span>
          )}
        </label>
        <span className="text-xs tabular-nums text-zinc-500">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Filters</span>
        {ATTR_FILTERS.map((a) => (
          <FilterChip
            key={a.key}
            label={a.label}
            state={attrFilters[a.key] ?? "any"}
            onClick={() => cycleAttr(a.key)}
          />
        ))}
        {activeAttrFilters.length > 0 && (
          <button
            type="button"
            onClick={() => setAttrFilters({})}
            className="ml-1 text-xs text-zinc-500 underline hover:text-zinc-700"
          >
            Clear
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Style</th>
              <th className="px-4 py-3">PO</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Business area</th>
              <th className="px-4 py-3">Group</th>
              <th
                className="px-4 py-3"
                title="% of required columns filled. The tick marks the threshold a style must reach before it can generate."
              >
                Completion
              </th>
              <th
                className="px-4 py-3"
                title="Required fields filled / total (Settings ▸ Required fields)."
              >
                Generation
              </th>
              <th className="px-4 py-3">Status</th>
              <th
                className="px-4 py-3"
                title="PO → EAN resolution: auto-queued when a PO is filled, then the PO PDF is scraped for the per-size barcodes. Click Resolve to run it now."
              >
                EAN
              </th>
              <th className="px-4 py-3">Last synced</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-zinc-500">
                  {rows.length === 0
                    ? "No styles yet. Run a Fill (or trigger a Monday webhook) to ingest."
                    : "No styles match the current search."}
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/styles/${s.id}`}
                      title={s.name}
                      className="block max-w-[220px] truncate hover:underline"
                    >
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{s.poNumber ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.customerName}</td>
                  <td className="px-4 py-3 text-zinc-600">{s.businessArea ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{s.groupTitle ?? "—"}</td>
                  <td className="px-4 py-3">
                    {(() => {
                      const ready =
                        s.hasProdSpec && s.threshold != null && s.completionPct >= s.threshold;
                      return (
                        <div
                          className="flex items-center gap-2"
                          title={
                            s.hasProdSpec
                              ? `${s.completionPct}% of required columns filled · threshold ${s.threshold}%`
                              : "No Prod Spec linked — can't generate yet"
                          }
                        >
                          <div className="relative h-2 w-24 overflow-hidden rounded-full bg-zinc-100">
                            <div
                              className={`h-full ${ready ? "bg-emerald-500" : "bg-zinc-900"}`}
                              style={{ width: `${s.completionPct}%` }}
                            />
                            {s.threshold != null && s.threshold < 100 && (
                              <div
                                className="absolute top-0 h-full w-0.5 bg-zinc-500"
                                style={{ left: `${s.threshold}%` }}
                              />
                            )}
                          </div>
                          <span
                            className={`text-xs tabular-nums ${ready ? "text-emerald-600" : "text-zinc-600"}`}
                          >
                            {s.completionPct}%
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    {s.requiredTotal > 0 ? (
                      <span
                        title={`${s.requiredFilled} of ${s.requiredTotal} required fields have a value`}
                        className={`text-sm font-semibold tabular-nums ${
                          s.requiredFilled === s.requiredTotal ? "text-emerald-600" : "text-amber-600"
                        }`}
                      >
                        {s.requiredFilled}/{s.requiredTotal}
                      </span>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[s.status] ?? "bg-zinc-100 text-zinc-700"
                      }`}
                    >
                      {s.status.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <EanCell
                      stored={s.eanStatus}
                      result={eanResults[s.id]}
                      onResolve={() => resolveEans(s.id)}
                    />
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{s.lastSyncedAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EanCell({
  stored,
  result,
  onResolve,
}: {
  stored: string;
  result: EanView | "loading" | undefined;
  onResolve: () => void;
}) {
  if (result === "loading") {
    return <span className="text-xs text-blue-600">resolving…</span>;
  }
  // A fresh manual resolve (result) overrides the stored badge in-place.
  const status = result ? result.status : stored;
  const meta = eanStatusMeta(status);
  const total = result ? result.sizeEans.length : 0;
  const filled = result ? result.sizeEans.filter((s) => s.ean13).length : 0;
  const showBadge = status !== "NONE" || Boolean(result);

  return (
    <div className="flex items-center gap-1.5">
      {showBadge && (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}
          title={result ? eanTooltip(result) : undefined}
        >
          {meta.label}
          {result && total > 0 ? ` · ${filled}/${total}` : ""}
        </span>
      )}
      <button
        type="button"
        onClick={onResolve}
        title="Scrape this PO's PDF now and read out the per-size EANs"
        className="shrink-0 rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50"
      >
        {showBadge ? "↻" : "Resolve"}
      </button>
    </div>
  );
}

function eanTooltip(r: EanView): string {
  const lines: string[] = [];
  if (r.poFileName) lines.push(r.poFileName);
  for (const s of r.sizeEans) lines.push(`${s.size}: ${s.ean13 ?? "— no match"}`);
  if (r.cartonEan) lines.push(`carton: ${r.cartonEan}`);
  if (r.message) lines.push(r.message);
  return lines.join("\n");
}

// Tri-state attribute filter chip. Click cycles any → has → no → any. The
// label gains a "Has "/"No " prefix and a green/red tint to make the active
// direction obvious at a glance.
function FilterChip({
  label,
  state,
  onClick,
}: {
  label: string;
  state: TriState;
  onClick: () => void;
}) {
  const cls =
    state === "has"
      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
      : state === "no"
        ? "border-red-300 bg-red-50 text-red-700"
        : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50";
  const text = state === "has" ? `Has ${label}` : state === "no" ? `No ${label}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={state !== "any"}
      title="Click to cycle: any → has → none"
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${cls}`}
    >
      {text}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
