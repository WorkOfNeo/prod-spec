"use client";

// Single-input filtered table for /styles. Mirrors prod-specs-table.tsx
// in approach: server-side fetches all rows once, client filters with
// substring match on a pre-built blob (name + customer + BA + PO# +
// status). Trade-off: ~4k rows live in the DOM, but the table is light
// (no per-row interactivity) so browsers handle it fine.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  STATUS_FACET_KEYS,
  STATUS_FACET_LABELS,
  type EffectiveStatus,
} from "@/lib/styles/effective-status";
import {
  STYLE_TABLE_COLUMNS,
  RESOLVED_FIELD_COLUMN_KEYS,
  type StyleColumnKey,
} from "@/lib/styles/table-columns";
import type { SupplierUploadRollup, ReviewRollup } from "@/lib/styles/table-rollups";
// Type-only on purpose: related.ts imports @/lib/db, and only an erased
// `import type` keeps Prisma out of this client bundle.
import type { LookalikeChip } from "@/lib/styles/related";
import { mondayItemUrl } from "@/lib/monday/url";
import { eanStatusMeta, EAN_STATUS_META } from "@/lib/po/ean-status-meta";
import { BLANK_BA_VALUES } from "@/lib/import/heuristics";
import type { EanView } from "@/lib/po/ean-view";
import { SkipSupplierDeliveryBadge } from "@/components/skip-supplier-delivery-badge";
import { ReadinessPill } from "@/components/output-readiness-notice";
import type { ReadinessNotice } from "@/lib/styles/readiness-notice";
import { ColumnsPopover } from "./columns-popover";
import { FacetFilter, type FacetOption } from "@/components/facet-filter";
import { BulkRunOutputs } from "./bulk-run-outputs";

// Hover hints on column headers.
const HEADER_HINTS: Partial<Record<StyleColumnKey, string>> = {
  completion:
    "% of required columns filled. The tick marks the threshold a style must reach before it can generate.",
  generation: "Required fields filled / total (Settings ▸ Required fields).",
  status:
    "Review flow once PDFs exist (queued → ready for review → approved / rejected); before that, field readiness (awaiting data → partially ready → ready to generate).",
  ean: "PO → EAN resolution: auto-queued when a PO is filled, then the PO PDF is scraped for the per-size barcodes. Click Resolve to run it now.",
};

// Attribute *presence* filters shown as chips below the facet bar. Each is
// tri-state: "any" (ignored), "has" (row must HAVE the attribute), "no"
// (row must LACK it). Customer is intentionally absent — every style has a
// required customer FK, so a "Has Customer" filter would never narrow.
// Business area is absent too: it graduated to a value-picking facet dropdown
// (filter by *which* BA, not just has/lacks one).
type TriState = "any" | "has" | "no";
const NEXT_STATE: Record<TriState, TriState> = { any: "has", has: "no", no: "any" };

const ATTR_FILTERS: ReadonlyArray<{ key: string; label: string; has: (r: StyleRow) => boolean }> = [
  // Reads the server-computed flag (hasPoNumber) rather than re-deriving it,
  // so the chip and the default-view gate can't disagree about what counts as
  // a PO number. Setting this chip to "No PO" is ALSO what reveals the rows
  // the gate hides — see the filter loop.
  { key: "po", label: "PO", has: (r) => !r.missingPo },
  // "Applied" = linked AND active. A linked-but-inactive spec counts as "No
  // Prod spec" here — it won't generate, so it shouldn't read as having a
  // working spec (see prodSpecActive in page.tsx).
  { key: "prodSpec", label: "Prod spec", has: (r) => r.prodSpecActive },
  { key: "supplier", label: "Supplier", has: (r) => r.hasSupplier },
  // Manually pulled in for layout testing (Settings ▸ Pull style by PO).
  { key: "pulled", label: "Pulled", has: (r) => r.pulledForTest },
];

// The five value-picking facet dropdowns. Within a facet selections are OR'd
// (Netto OR Børn); across facets they're AND'd (customer ∈ {…} AND status ∈
// {…}). Options are derived from the loaded rows, so a value only appears if
// a real style carries it — "based off actual data in the board".
type FacetKey = "customer" | "ba" | "group" | "status" | "ean";
const FACET_KEYS: readonly FacetKey[] = ["customer", "ba", "group", "status", "ean"];
const EMPTY_FACETS: Record<FacetKey, string[]> = {
  customer: [],
  ba: [],
  group: [],
  status: [],
  ean: [],
};

// Sentinel so blank / "–" business areas and null groups collapse into one
// selectable "(blank)" option instead of vanishing. The leading-space prefix
// can't collide with a real (trimmed) value carried by a row.
const BLANK_VALUE = "__blank__";

function baValue(r: StyleRow): string {
  const v = r.businessArea;
  if (v == null) return BLANK_VALUE;
  const t = v.trim();
  return BLANK_BA_VALUES.has(t) ? BLANK_VALUE : t;
}
function groupValue(r: StyleRow): string {
  const t = r.groupTitle?.trim();
  return t ? t : BLANK_VALUE;
}
function customerValue(r: StyleRow): string {
  return r.customerName.trim() || BLANK_VALUE;
}

// Two string[]s as unordered sets — drives the Apply button's dirty state.
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((v) => s.has(v));
}

// ── URL persistence ──────────────────────────────────────────────────────
// The active filter (search + applied facets + attribute chips + archived)
// round-trips through the query string so it survives back-navigation from a
// style detail page — and is shareable / refreshable. Writing is *shallow*
// (window.history.replaceState, see the effect in StylesTable) so the page's
// ~4k-row server query never re-runs as the user types or picks facets.
//
// Facet values are real data (customer / BA / group names), so each selection
// is its own repeated key (?customer=Netto&customer=Børn) — read with getAll,
// no delimiter that a value could contain. Attribute chips are a fixed enum,
// so they pack into with=/without= lists.
type ParamReader = Pick<URLSearchParams, "get" | "getAll">;
const ATTR_KEYS = new Set(ATTR_FILTERS.map((a) => a.key));

function parseFacetsFromUrl(sp: ParamReader): Record<FacetKey, string[]> {
  return {
    customer: sp.getAll("customer"),
    ba: sp.getAll("ba"),
    group: sp.getAll("group"),
    status: sp.getAll("status"),
    ean: sp.getAll("ean"),
  };
}

function parseAttrsFromUrl(sp: ParamReader): Record<string, TriState> {
  const out: Record<string, TriState> = {};
  for (const key of sp.getAll("with")) if (ATTR_KEYS.has(key)) out[key] = "has";
  for (const key of sp.getAll("without")) if (ATTR_KEYS.has(key)) out[key] = "no";
  return out;
}

// State → query string. Fixed key/value ordering keeps the URL stable (no
// churn from re-serialising the same selection in a different order).
function serializeFilters(state: {
  q: string;
  showArchived: boolean;
  attrFilters: Record<string, TriState>;
  appliedFacets: Record<FacetKey, string[]>;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set("q", state.q);
  for (const k of FACET_KEYS) for (const v of state.appliedFacets[k]) params.append(k, v);
  for (const a of ATTR_FILTERS) {
    const s = state.attrFilters[a.key];
    if (s === "has") params.append("with", a.key);
    else if (s === "no") params.append("without", a.key);
  }
  if (state.showArchived) params.set("archived", "1");
  return params;
}

export type StyleRow = {
  id: string;
  name: string;
  poNumber: string | null;
  // Set when this style's name also exists on another PO's Monday row — the
  // "1 of 2 rows with this name" chip. Null (the common case) renders nothing.
  // Computed server-side in ONE bulk query; see src/lib/styles/related.ts.
  lookalike: LookalikeChip | null;
  customerName: string;
  // Customer.config.skipSupplierDelivery — shows a "Delivers own" chip next
  // to the customer so the row isn't mistaken for one that sends supplier
  // delivery on generation.
  customerDeliversOwn: boolean;
  businessArea: string | null;
  completionPct: number;
  // % of required columns this style must reach before it can generate.
  // From the linked ProdSpec; null when no ProdSpec is linked.
  threshold: number | null;
  hasProdSpec: boolean;
  // Linked AND active — the "Prod spec" chip's "applied" sense. Distinct from
  // hasProdSpec (mere linkage), which the completion column still relies on.
  prodSpecActive: boolean;
  hasSupplier: boolean;
  // Required detail fields filled / total (Settings ▸ Required fields).
  // requiredTotal 0 = none configured.
  requiredFilled: number;
  requiredTotal: number;
  // The Status pill — computed: review flow when PDFs/jobs exist, otherwise
  // the field-readiness ladder. See computeEffectiveStatus(). Drives the
  // Status facet filter + searchBlob; the *visible* pill now renders `notice`.
  statusView: EffectiveStatus;
  // Cause-aware readiness notice (harder-blocker-wins headline + count). This
  // is what the Status cell renders via <ReadinessPill>. statusView remains the
  // filtering/sorting key — do not swap that.
  notice: ReadinessNotice;
  // PO → EAN resolution state (StyleEanStatus). Badge via eanStatusMeta.
  eanStatus: string;
  groupTitle: string | null;
  // Server-computed: hide behind "Show archived". Done/cancelled/archived
  // groups — except Done-group styles re-admitted by the PO cutoff, which
  // stay in the main view (see /styles page query).
  archived: boolean;
  // Manually pulled into the styleboard for layout testing — surfaced via the
  // "Pulled" attribute chip (Settings ▸ Pull style by PO).
  pulledForTest: boolean;
  // Server-computed: no PO number ("Navision Task") on the Monday row. Hidden
  // from the default view — nothing generates without a PO, so these styles
  // haven't entered the flow. Revealed by the "No PO" chip.
  missingPo: boolean;
  lastSyncedAt: string;
  searchBlob: string;
  // ── Opt-in columns (hydrated only when the column is visible) ──
  // Identity & links — small, always hydrated.
  supplierName: string | null;
  supplierCountry: string | null;
  prodSpecName: string | null;
  prodSpecId: string | null;
  cartonEan: string | null;
  poFileName: string | null;
  styleFolderUrl: string | null;
  mondayItemId: string | null;
  mondayBoardId: string | null;
  createdAt: string;
  updatedAt: string;
  // SharePoint & delivery.
  folderConnected: boolean;
  supplierFolderUrl: string | null;
  upload: SupplierUploadRollup | null;
  // Spec fields, keyed by column key (only the visible ones are present).
  resolved: Record<string, string>;
  // Review / approval rollup (null unless a review column is on).
  review: ReviewRollup | null;
};

// Hover text for the status pill: the count (which moves out of the headline
// when a harder blocker wins) plus the top blocking step's detail, so the row
// still explains itself on hover. Falls back to the headline when nothing
// blocks.
function statusTitle(notice: ReadinessNotice): string {
  const blocking = notice.steps.find((s) => s.tone === "red" || s.tone === "amber");
  const count = notice.total > 0 ? `${notice.ready} of ${notice.total} ready` : null;
  const detail = blocking ? `${blocking.title} — ${blocking.detail}` : notice.headline;
  return count && detail !== count ? `${count}\n${detail}` : detail;
}

export function StylesTable({
  rows,
  autoGenerateEnabled,
  visibleColumns,
  canConfigureColumns,
  isAdmin,
}: {
  rows: StyleRow[];
  autoGenerateEnabled: boolean;
  // The admin-defined standard view (AppSetting), already normalized.
  visibleColumns: StyleColumnKey[];
  // ADMIN gets the Columns popover; saves apply to everyone.
  canConfigureColumns: boolean;
  // ADMIN gets the "Run all outputs" bulk action over the current filter.
  // REVIEWERs see the styles list but never the run controls.
  isAdmin: boolean;
}) {
  // Seed the filter state from the URL once, on mount. All later changes flow
  // state → URL (the effect below), never URL → state, so we don't fight the
  // user's typing. Read via useSearchParams (not window) to stay SSR-safe.
  const searchParams = useSearchParams();
  const seed = useMemo(
    () => ({
      q: searchParams.get("q") ?? "",
      showArchived: searchParams.get("archived") === "1",
      attrFilters: parseAttrsFromUrl(searchParams),
      facets: parseFacetsFromUrl(searchParams),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
    [],
  );

  const [q, setQ] = useState(seed.q);
  // Live column set — seeded from the server-read setting, updated
  // optimistically by the Columns popover.
  const [visible, setVisible] = useState<StyleColumnKey[]>(visibleColumns);
  const [showArchived, setShowArchived] = useState(seed.showArchived);
  // Per-attribute tri-state presence filters (keyed by ATTR_FILTERS.key).
  const [attrFilters, setAttrFilters] = useState<Record<string, TriState>>(seed.attrFilters);

  const cycleAttr = (key: string) =>
    setAttrFilters((p) => ({ ...p, [key]: NEXT_STATE[p[key] ?? "any"] }));
  const activeAttrFilters = ATTR_FILTERS.filter((a) => (attrFilters[a.key] ?? "any") !== "any");

  // Value-picking facet filters. `draft` is what's checked in the dropdowns
  // right now; `applied` is what the table actually filters by. They diverge
  // until the user presses Apply (or Clear all) — see the filter bar below.
  const [draftFacets, setDraftFacets] = useState<Record<FacetKey, string[]>>(seed.facets);
  const [appliedFacets, setAppliedFacets] = useState<Record<FacetKey, string[]>>(seed.facets);
  const setFacet = (key: FacetKey, next: string[]) =>
    setDraftFacets((p) => ({ ...p, [key]: next }));
  const applyFacets = () => setAppliedFacets(draftFacets);
  const clearAllFacets = () => {
    setDraftFacets(EMPTY_FACETS);
    setAppliedFacets(EMPTY_FACETS);
  };
  // Apply is enabled only when the draft differs from what's applied.
  const facetsDirty = useMemo(
    () => FACET_KEYS.some((k) => !sameSet(draftFacets[k], appliedFacets[k])),
    [draftFacets, appliedFacets],
  );
  const anyFacetActive = useMemo(
    () => FACET_KEYS.some((k) => appliedFacets[k].length > 0 || draftFacets[k].length > 0),
    [appliedFacets, draftFacets],
  );

  // Persist the active filter to the URL with a *shallow* replaceState — no
  // router navigation, so the server query doesn't re-run on every keystroke,
  // and (replace, not push) keystrokes don't each become a history entry. This
  // is what makes the search + facets survive Back from a style detail page.
  // Mirrors appliedFacets (what filters the table), not draftFacets (the
  // in-dropdown selection awaiting Apply).
  useEffect(() => {
    const qs = serializeFilters({ q, showArchived, attrFilters, appliedFacets }).toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [q, showArchived, attrFilters, appliedFacets]);

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

  // Styles with no PO number ("Navision Task" unset on the Monday row). The
  // server loads them (activeStylesWhere({ includeMissingPo: true })) but the
  // flow starts at the PO, so they stay out of the default view. The reveal is
  // the PO chip's third state: "No PO" shows exactly this set — no extra
  // toggle, and the chip's own filter already narrows to it, so the two agree
  // by construction.
  const missingPoFlags = useMemo(() => rows.map((r) => r.missingPo), [rows]);
  const missingPoCount = useMemo(() => missingPoFlags.filter(Boolean).length, [missingPoFlags]);
  const revealMissingPo = (attrFilters.po ?? "any") === "no";

  // Distinct option lists (+counts) per facet, derived once from the loaded
  // rows — a value only appears if a real style carries it. Counts are over
  // all loaded rows (static); they don't react to other facets' selections
  // (a "smart counts" v2). Customer/BA/Group sort alphabetically; Status and
  // EAN follow their ladder/enum order.
  const facetOptions = useMemo(() => {
    const customer = new Map<string, number>();
    const ba = new Map<string, number>();
    const group = new Map<string, number>();
    const status = new Map<string, number>();
    const ean = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of rows) {
      bump(customer, customerValue(r));
      bump(ba, baValue(r));
      bump(group, groupValue(r));
      bump(status, r.statusView.key);
      bump(ean, r.eanStatus);
    }
    const alpha = (m: Map<string, number>): FacetOption[] =>
      [...m.entries()]
        .map(([value, count]) => ({
          value,
          label: value === BLANK_VALUE ? "(blank)" : value,
          count,
        }))
        .sort((a, b) =>
          a.value === BLANK_VALUE
            ? 1
            : b.value === BLANK_VALUE
              ? -1
              : a.label.localeCompare(b.label),
        );
    const statusOpts: FacetOption[] = STATUS_FACET_KEYS.filter((k) => status.has(k)).map((k) => ({
      value: k,
      label: STATUS_FACET_LABELS[k],
      count: status.get(k) ?? 0,
    }));
    const eanOrder = Object.keys(EAN_STATUS_META);
    const eanOpts: FacetOption[] = [...ean.entries()]
      .map(([value, count]) => ({ value, label: eanStatusMeta(value).label, count }))
      .sort((a, b) => eanOrder.indexOf(a.value) - eanOrder.indexOf(b.value));
    return {
      customer: alpha(customer),
      ba: alpha(ba),
      group: alpha(group),
      status: statusOpts,
      ean: eanOpts,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Pre-build a Set per active facet so the row loop is membership-only.
    const fa = appliedFacets;
    const cSet = fa.customer.length ? new Set(fa.customer) : null;
    const bSet = fa.ba.length ? new Set(fa.ba) : null;
    const gSet = fa.group.length ? new Set(fa.group) : null;
    const sSet = fa.status.length ? new Set(fa.status) : null;
    const eSet = fa.ean.length ? new Set(fa.ean) : null;
    return rows.filter((r, i) => {
      if (!showArchived && archivedFlags[i]) return false;
      if (!revealMissingPo && missingPoFlags[i]) return false;
      // Value facets: OR within a facet (Set membership), AND across facets.
      if (cSet && !cSet.has(customerValue(r))) return false;
      if (bSet && !bSet.has(baValue(r))) return false;
      if (gSet && !gSet.has(groupValue(r))) return false;
      if (sSet && !sSet.has(r.statusView.key)) return false;
      if (eSet && !eSet.has(r.eanStatus)) return false;
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
  }, [
    rows,
    q,
    showArchived,
    archivedFlags,
    revealMissingPo,
    missingPoFlags,
    attrFilters,
    activeAttrFilters,
    appliedFacets,
  ]);

  // The exact set the bulk "Run all outputs" action targets — the filtered
  // rows, in table order. The browser already holds the filtered list, so the
  // ids go straight to the server (no need to re-derive the filter there).
  const filteredIds = useMemo(() => filtered.map((r) => r.id), [filtered]);

  // A human description of the active filter, stored on the batch so the
  // progress widget reads "Customer: Netto · Ready to generate · 42 styles"
  // and a returning admin can tell which run they kicked off.
  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    const lbl = (v: string) => (v === BLANK_VALUE ? "(blank)" : v);
    const statusLabels = STATUS_FACET_LABELS as Record<string, string>;
    if (appliedFacets.customer.length)
      parts.push(`Customer: ${appliedFacets.customer.map(lbl).join(", ")}`);
    if (appliedFacets.ba.length) parts.push(`Business Area: ${appliedFacets.ba.map(lbl).join(", ")}`);
    if (appliedFacets.group.length) parts.push(`Group: ${appliedFacets.group.map(lbl).join(", ")}`);
    if (appliedFacets.status.length)
      parts.push(`Status: ${appliedFacets.status.map((k) => statusLabels[k] ?? k).join(", ")}`);
    if (appliedFacets.ean.length)
      parts.push(`EAN: ${appliedFacets.ean.map((k) => eanStatusMeta(k).label).join(", ")}`);
    for (const a of activeAttrFilters)
      parts.push(`${attrFilters[a.key] === "has" ? "Has" : "No"} ${a.label}`);
    if (q.trim()) parts.push(`"${q.trim()}"`);
    if (showArchived) parts.push("incl. archived");
    parts.push(`${filtered.length} styles`);
    return parts.join(" · ");
  }, [appliedFacets, activeAttrFilters, attrFilters, q, showArchived, filtered.length]);

  // Render order = registry order filtered by the visible set, so the
  // column layout always matches table-columns.ts.
  const columns = useMemo(() => {
    const set = new Set(visible);
    return STYLE_TABLE_COLUMNS.filter((c) => set.has(c.key));
  }, [visible]);

  // One cell per column key — keyed <td>s so a row can map over the
  // visible registry columns directly.
  function cellFor(key: StyleColumnKey, s: StyleRow) {
    // Spec-field columns all render the same way: the resolved value (or "—"),
    // truncated. One branch covers every mapped field.
    if (RESOLVED_FIELD_COLUMN_KEYS.has(key)) {
      const v = s.resolved[key]?.trim();
      return (
        <td key={key} className="px-4 py-3 text-zinc-600">
          <span className="block max-w-[240px] truncate" title={v || undefined}>
            {v || <span className="text-zinc-300">—</span>}
          </span>
        </td>
      );
    }
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
            {/* Same style name on more than one PO. The wrong row gets picked
                HERE, mid-search, before anything is opened — the style page's
                related-rows card is only the backstop. */}
            {s.lookalike && (
              <span
                className="mt-0.5 inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                title={`Also on ${s.lookalike.otherPoNumbers.join(", ")} — check you are on the right Purchase Order`}
              >
                {s.lookalike.position} of {s.lookalike.total} rows with this name
              </span>
            )}
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
            <span className="flex items-center gap-1.5">
              {s.customerName}
              {s.customerDeliversOwn && <SkipSupplierDeliveryBadge variant="chip" />}
            </span>
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
            <span title={statusTitle(s.notice)}>
              <ReadinessPill notice={s.notice} />
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

      // ── Identity & links ──────────────────────────────────────────────
      case "supplier":
        return (
          <td key={key} className="px-4 py-3 text-zinc-600">
            {s.supplierName ? (
              <span className="block max-w-[220px] truncate" title={s.supplierName}>
                {s.supplierName}
                {s.supplierCountry ? (
                  <span className="text-zinc-400"> · {s.supplierCountry}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "prodSpec":
        return (
          <td key={key} className="px-4 py-3 text-zinc-600">
            {s.prodSpecName ? (
              s.prodSpecId ? (
                <Link
                  href={`/prod-specs/${s.prodSpecId}`}
                  title={s.prodSpecName}
                  className="block max-w-[200px] truncate underline hover:text-zinc-900"
                >
                  {s.prodSpecName}
                </Link>
              ) : (
                <span className="block max-w-[200px] truncate">{s.prodSpecName}</span>
              )
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "cartonEan":
        return (
          <td key={key} className="px-4 py-3 tabular-nums text-zinc-600">
            {s.cartonEan ?? <span className="text-zinc-300">—</span>}
          </td>
        );
      case "poFile":
        return (
          <td key={key} className="px-4 py-3 text-zinc-500">
            <span className="block max-w-[220px] truncate" title={s.poFileName ?? undefined}>
              {s.poFileName ?? <span className="text-zinc-300">—</span>}
            </span>
          </td>
        );
      case "styleFolder":
        return (
          <td key={key} className="px-4 py-3">
            {s.styleFolderUrl ? (
              <a
                href={s.styleFolderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-600 underline hover:text-zinc-900"
              >
                Open ↗
              </a>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "monday": {
        const url = mondayItemUrl(s.mondayBoardId, s.mondayItemId);
        return (
          <td key={key} className="px-4 py-3 text-zinc-500">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-zinc-900"
              >
                {s.mondayItemId}
              </a>
            ) : (
              s.mondayItemId ?? <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      }
      case "created":
        return (
          <td key={key} className="px-4 py-3 text-zinc-500">
            {s.createdAt}
          </td>
        );
      case "updated":
        return (
          <td key={key} className="px-4 py-3 text-zinc-500">
            {s.updatedAt}
          </td>
        );

      // ── SharePoint & delivery ─────────────────────────────────────────
      case "sharepoint":
        return (
          <td key={key} className="px-4 py-3">
            <UploadCell upload={s.upload} deliversOwn={s.customerDeliversOwn} />
          </td>
        );
      case "folderConnected":
        return (
          <td key={key} className="px-4 py-3">
            {s.folderConnected ? (
              <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                ✓ Connected
              </span>
            ) : (
              <span
                className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500"
                title="No “Supplier Folder” link on the Suppliers board"
              >
                Not linked
              </span>
            )}
          </td>
        );
      case "approvedFolder":
        return (
          <td key={key} className="px-4 py-3">
            {s.supplierFolderUrl ? (
              <a
                href={s.supplierFolderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-600 underline hover:text-zinc-900"
              >
                Open ↗
              </a>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "deliversOwn":
        return (
          <td key={key} className="px-4 py-3">
            {s.customerDeliversOwn ? (
              <SkipSupplierDeliveryBadge variant="chip" />
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );

      // ── Review & approval ─────────────────────────────────────────────
      case "approved":
        return (
          <td key={key} className="px-4 py-3">
            {s.review && s.review.total > 0 ? (
              <span
                title={`${s.review.approved} of ${s.review.total} outputs approved · ${s.review.generated} generated`}
                className={`text-sm font-semibold tabular-nums ${
                  s.review.fullyApproved ? "text-emerald-600" : "text-zinc-600"
                }`}
              >
                {s.review.approved}/{s.review.total}
              </span>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "fullyApproved":
        return (
          <td key={key} className="px-4 py-3">
            {s.review && s.review.total > 0 && s.review.fullyApproved ? (
              <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                ✓ Fully approved
              </span>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );
      case "awaitingReview":
        return (
          <td key={key} className="px-4 py-3">
            {s.review && s.review.awaiting > 0 ? (
              <span
                title={`${s.review.awaiting} output${s.review.awaiting === 1 ? "" : "s"} still to decide`}
                className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700"
              >
                {s.review.awaiting}
              </span>
            ) : (
              <span className="text-zinc-300">—</span>
            )}
          </td>
        );

      default:
        // Any registry key without an explicit cell still renders an (empty)
        // <td> so the row's column count matches the header.
        return <td key={key} className="px-4 py-3 text-zinc-300">—</td>;
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

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Filter by</span>
        <FacetFilter
          label="Customer"
          options={facetOptions.customer}
          selected={draftFacets.customer}
          onChange={(n) => setFacet("customer", n)}
        />
        <FacetFilter
          label="Business Area"
          options={facetOptions.ba}
          selected={draftFacets.ba}
          onChange={(n) => setFacet("ba", n)}
        />
        <FacetFilter
          label="Group"
          options={facetOptions.group}
          selected={draftFacets.group}
          onChange={(n) => setFacet("group", n)}
        />
        <FacetFilter
          label="Status"
          options={facetOptions.status}
          selected={draftFacets.status}
          onChange={(n) => setFacet("status", n)}
        />
        <FacetFilter
          label="EAN"
          options={facetOptions.ean}
          selected={draftFacets.ean}
          onChange={(n) => setFacet("ean", n)}
        />
        <button
          type="button"
          onClick={applyFacets}
          disabled={!facetsDirty}
          className="ml-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          Apply{facetsDirty ? " •" : ""}
        </button>
        {anyFacetActive && (
          <button
            type="button"
            onClick={clearAllFacets}
            className="text-xs text-zinc-500 underline hover:text-zinc-700"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Attributes</span>
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
        {/* Says out loud that rows are being withheld, and names the one
            click that brings them back — a silent gate is how "my style
            vanished" tickets get written. */}
        {missingPoCount > 0 && !revealMissingPo && (
          <span className="text-xs text-zinc-400">
            <span className="tabular-nums">{missingPoCount}</span> hidden — no PO number yet.{" "}
            <button
              type="button"
              onClick={() => setAttrFilters((p) => ({ ...p, po: "no" }))}
              className="underline hover:text-zinc-600"
            >
              Show them
            </button>
          </span>
        )}
      </div>

      {isAdmin && <BulkRunOutputs styleIds={filteredIds} filterLabel={filterLabel} />}

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
                  {rows.length === 0 ? (
                    "No styles yet. Run a Fill (or trigger a Monday webhook) to ingest."
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <span>No styles match the current search or filters.</span>
                      {(anyFacetActive || q.trim().length > 0) && (
                        <button
                          type="button"
                          onClick={() => {
                            setQ("");
                            clearAllFacets();
                          }}
                          className="text-xs text-zinc-600 underline hover:text-zinc-900"
                        >
                          Clear search &amp; filters
                        </button>
                      )}
                    </div>
                  )}
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

// SharePoint-upload rollup for one style — collapses the supplier-send queue
// row statuses into a single badge, mirroring the single-style "Supplier
// folder" panel and /settings/approved. Folder-shaped gaps (missing /
// ambiguous PO folder) win over a plain count so the reason is visible.
function UploadCell({
  upload,
  deliversOwn,
}: {
  upload: SupplierUploadRollup | null;
  deliversOwn: boolean;
}) {
  if (deliversOwn) {
    return (
      <span
        className="text-xs text-zinc-400"
        title="Customer delivers their own goods — nothing is pushed to a supplier folder"
      >
        delivers own
      </span>
    );
  }
  if (!upload || upload.total === 0) return <span className="text-zinc-300">—</span>;
  const { uploaded, total, noFolder, ambiguous, failed, pending } = upload;
  const pill = (cls: string, text: string, title: string) => (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`} title={title}>
      {text}
    </span>
  );
  if (noFolder > 0)
    return pill(
      "bg-red-50 text-red-700",
      "PO folder missing",
      `${noFolder} output(s) can't find the PO folder in the supplier's SharePoint`,
    );
  if (ambiguous > 0)
    return pill(
      "bg-amber-50 text-amber-700",
      "ambiguous folder",
      `${ambiguous} output(s): several folders match the PO — delete the extras`,
    );
  if (uploaded === total)
    return pill(
      "bg-emerald-50 text-emerald-700",
      `✓ ${uploaded}/${total}`,
      `all ${total} approved output(s) uploaded to the supplier folder`,
    );
  const cls = failed > 0 ? "bg-amber-50 text-amber-700" : "bg-zinc-100 text-zinc-600";
  const note = failed > 0 ? `${failed} failed` : `${pending} pending`;
  return pill(cls, `${uploaded}/${total}`, `${uploaded} uploaded · ${note}`);
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
