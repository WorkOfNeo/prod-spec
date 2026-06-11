"use client";

// Single-input filtered table for /styles. Mirrors prod-specs-table.tsx
// in approach: server-side fetches all rows once, client filters with
// substring match on a pre-built blob (name + customer + BA + PO# +
// status). Trade-off: ~4k rows live in the DOM, but the table is light
// (no per-row interactivity) so browsers handle it fine.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EffectiveStatus } from "@/lib/styles/effective-status";
import { STYLE_TABLE_COLUMNS, type StyleColumnKey } from "@/lib/styles/table-columns";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import type { EanView } from "@/lib/po/ean-view";
import { ColumnsPopover } from "./columns-popover";

// Status pill colour per EffectiveStatus tone (see effective-status.ts —
// review flow once PDFs exist, field-readiness ladder before).
const TONE_STYLES: Record<EffectiveStatus["tone"], string> = {
  zinc: "bg-zinc-100 text-zinc-600",
  amber: "bg-amber-100 text-amber-800",
  green: "bg-emerald-100 text-emerald-800",
  blue: "bg-blue-100 text-blue-800",
  purple: "bg-purple-100 text-purple-800",
  red: "bg-red-100 text-red-800",
};

// Hover hints on column headers.
const HEADER_HINTS: Partial<Record<StyleColumnKey, string>> = {
  completion:
    "% of required columns filled. The tick marks the threshold a style must reach before it can generate.",
  generation: "Required fields filled / total (Settings ▸ Required fields).",
  status:
    "Review flow once PDFs exist (queued → ready for review → approved / rejected); before that, field readiness (awaiting data → partially ready → ready to generate).",
  ean: "PO → EAN resolution: auto-queued when a PO is filled, then the PO PDF is scraped for the per-size barcodes. Click Resolve to run it now.",
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
  // The Status pill — computed: review flow when PDFs/jobs exist, otherwise
  // the field-readiness ladder. See computeEffectiveStatus().
  statusView: EffectiveStatus;
  // PO → EAN resolution state (StyleEanStatus). Badge via eanStatusMeta.
  eanStatus: string;
  groupTitle: string | null;
  // Server-computed: hide behind "Show archived". Done/cancelled/archived
  // groups — except Done-group styles re-admitted by the PO cutoff, which
  // stay in the main view (see /styles page query).
  archived: boolean;
  lastSyncedAt: string;
  searchBlob: string;
};

export function StylesTable({
  rows,
  autoGenerateEnabled,
  visibleColumns,
  canConfigureColumns,
}: {
  rows: StyleRow[];
  autoGenerateEnabled: boolean;
  // The admin-defined standard view (AppSetting), already normalized.
  visibleColumns: StyleColumnKey[];
  // ADMIN gets the Columns popover; saves apply to everyone.
  canConfigureColumns: boolean;
}) {
  const [q, setQ] = useState("");
  // Live column set — seeded from the server-read setting, updated
  // optimistically by the Columns popover.
  const [visible, setVisible] = useState<StyleColumnKey[]>(visibleColumns);
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

  // Server-computed archived flags (groupTitle heuristics + PO-cutoff
  // exception) — read once so the filter loop is cheap.
  const archivedFlags = useMemo(
    () => rows.map((r) => r.archived),
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

  // Render order = registry order filtered by the visible set, so the
  // column layout always matches table-columns.ts.
  const columns = useMemo(() => {
    const set = new Set(visible);
    return STYLE_TABLE_COLUMNS.filter((c) => set.has(c.key));
  }, [visible]);

  // One cell per column key — keyed <td>s so a row can map over the
  // visible registry columns directly.
  function cellFor(key: StyleColumnKey, s: StyleRow) {
    switch (key) {
      case "style":
        return (
          <td key={key} className="px-4 py-3 font-medium">
            <Link
              href={`/styles/${s.id}`}
              title={s.name}
              className="block max-w-[220px] truncate hover:underline"
            >
              {s.name}
            </Link>
          </td>
        );
      case "po":
        return (
          <td key={key} className="px-4 py-3 tabular-nums text-zinc-600">
            {s.poNumber ?? "—"}
          </td>
        );
      case "customer":
        return (
          <td key={key} className="px-4 py-3 text-zinc-600">
            {s.customerName}
          </td>
        );
      case "businessArea":
        return (
          <td key={key} className="px-4 py-3 text-zinc-600">
            {s.businessArea ?? "—"}
          </td>
        );
      case "group":
        return (
          <td key={key} className="px-4 py-3 text-xs text-zinc-500">
            {s.groupTitle ?? "—"}
          </td>
        );
      case "completion": {
        const ready = s.hasProdSpec && s.threshold != null && s.completionPct >= s.threshold;
        return (
          <td key={key} className="px-4 py-3">
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
          </td>
        );
      }
      case "generation":
        return (
          <td key={key} className="px-4 py-3">
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
        );
      case "status":
        return (
          <td key={key} className="px-4 py-3">
            <span
              title={s.statusView.hint}
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TONE_STYLES[s.statusView.tone]}`}
            >
              {s.statusView.label}
            </span>
          </td>
        );
      case "ean":
        return (
          <td key={key} className="px-4 py-3">
            <EanCell
              stored={s.eanStatus}
              result={eanResults[s.id]}
              onResolve={() => resolveEans(s.id)}
            />
          </td>
        );
      case "lastSynced":
        return (
          <td key={key} className="px-4 py-3 text-zinc-500">
            {s.lastSyncedAt}
          </td>
        );
    }
  }

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
        {canConfigureColumns && <ColumnsPopover visible={visible} onChange={setVisible} />}
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
              {columns.map((c) => (
                <th key={c.key} className="px-4 py-3" title={HEADER_HINTS[c.key]}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-zinc-500">
                  {rows.length === 0
                    ? "No styles yet. Run a Fill (or trigger a Monday webhook) to ingest."
                    : "No styles match the current search."}
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100 hover:bg-zinc-50">
                  {columns.map((c) => cellFor(c.key, s))}
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
