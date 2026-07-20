"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BLANK_BA_VALUES } from "@/lib/import/heuristics";
import { DocTypesButton } from "./doc-types-dialog";
import type { ManagedDocType, ExclusionFieldOption } from "./doc-types-manager";

// Collapse blank / "–" business-area names (live DB carries literal "–"
// areas) into one selectable "(blank)" bucket. Plain ASCII sentinel.
const BLANK_BA = "__blank__";
const baKey = (name: string) => {
  const t = name.trim();
  return BLANK_BA_VALUES.has(t) ? BLANK_BA : t;
};

type LayoutRow = {
  id: string;
  name: string;
  docType: string;
  docTypeLabel: string;
  status: "DRAFT" | "PUBLISHED";
  version: number;
  autoApprove: boolean;
  pageCount: number;
  defInvalid: boolean;
  customerName: string | null;
  businessAreaName: string | null;
  updatedAt: string;
  // Generation history (server-computed): how many PDFs this layout has
  // produced across all styles, and when it last ran.
  generationCount: number;
  lastGeneratedAt: string | null;
  // Usage joins (computed server-side): the Prod Specs that carry this
  // layout as an enabled output (+ their customer and business area), and
  // the styles currently resolved to those specs. `styles` is capped —
  // `styleCount` is the exact total.
  prodSpecs: Array<{ id: string; name: string; customerName: string; businessAreaName: string }>;
  styleCount: number;
  styles: Array<{ id: string; name: string }>;
};

// Hover popover dropping DOWN from its trigger cell. Pure CSS
// (group-hover + focus-within keeps it keyboard-reachable); needs every
// ancestor between trigger and table wrapper to stay overflow-visible.
function HoverPopover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <div className="group relative inline-block" tabIndex={0}>
      <span className="cursor-default underline decoration-dotted decoration-zinc-300 underline-offset-2">
        {trigger}
      </span>
      <div className="invisible absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {children}
      </div>
    </div>
  );
}

export function LayoutsList({
  layouts,
  contrastLogoFound,
  contrastAddressLogoFound,
  docTypes,
  exclusionFields,
  openDocTypes = false,
  tabs,
}: {
  layouts: LayoutRow[];
  contrastLogoFound: boolean;
  contrastAddressLogoFound: boolean;
  // Doc-type catalogue (+ exclusion rules) and the synced fields rules can
  // match on — drive the "Document types" popup next to "New layout".
  docTypes: ManagedDocType[];
  exclusionFields: ExclusionFieldOption[];
  // Open the popup on mount (deep link from the editor's "Manage types").
  openDocTypes?: boolean;
  // Server-rendered tab bar (Layouts / File names) — passed in rather than
  // built here so the page owns which tab is active.
  tabs?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the search + filter dropdowns from the URL once, on mount, so they
  // survive back-navigation (e.g. returning from a layout) and are shareable.
  // All later changes flow state → URL via the effect below. Read through
  // useSearchParams (not window) to stay SSR-safe. Mirrors the pattern on
  // /styles · /prod-specs · /po-eans (see src/lib/use-url-search-state.ts).
  const searchParams = useSearchParams();
  const seed = useMemo(() => {
    const rawStatus = searchParams.get("status");
    const rawAuto = searchParams.get("auto");
    const status: "all" | "PUBLISHED" | "DRAFT" =
      rawStatus === "PUBLISHED" || rawStatus === "DRAFT" ? rawStatus : "all";
    const auto: "all" | "on" | "off" =
      rawAuto === "on" || rawAuto === "off" ? rawAuto : "all";
    const rawUsage = searchParams.get("inspec");
    const usage: "all" | "used" | "unused" =
      rawUsage === "used" || rawUsage === "unused" ? rawUsage : "all";
    return {
      q: searchParams.get("q") ?? "",
      type: searchParams.get("type") ?? "all",
      status,
      auto,
      usage,
      customer: searchParams.get("cust") ?? "all",
      ba: searchParams.get("ba") ?? "all",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);

  const [query, setQuery] = useState(seed.q);
  const [typeFilter, setTypeFilter] = useState(seed.type);
  const [statusFilter, setStatusFilter] = useState<"all" | "PUBLISHED" | "DRAFT">(seed.status);
  const [autoApproveFilter, setAutoApproveFilter] = useState<"all" | "on" | "off">(seed.auto);
  // Usage-derived filters — keyed on where the layout is actually used in a
  // Prod Spec (as an enabled output), NOT the test-data customer/BA binding.
  const [usageFilter, setUsageFilter] = useState<"all" | "used" | "unused">(seed.usage);
  const [customerFilter, setCustomerFilter] = useState(seed.customer);
  const [baFilter, setBaFilter] = useState(seed.ba);

  // Persist search + filters to the URL with a shallow replaceState — no
  // router navigation, so the page's server query doesn't re-run and Back
  // returns here with filters intact. Only non-default values are written, so
  // a cleared view keeps a clean URL. `selected` (the delete multi-select) is
  // transient interaction state and intentionally stays out of the URL.
  useEffect(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query);
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (autoApproveFilter !== "all") params.set("auto", autoApproveFilter);
    if (usageFilter !== "all") params.set("inspec", usageFilter);
    if (customerFilter !== "all") params.set("cust", customerFilter);
    if (baFilter !== "all") params.set("ba", baFilter);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [query, typeFilter, statusFilter, autoApproveFilter, usageFilter, customerFilter, baFilter]);
  // Multi-select + delete. `selected` holds ids across the full list (so a
  // selection survives filtering); `confirmRows` are the rows queued in the
  // delete confirmation modal (one row from the row button, or every selected
  // row from the bulk bar).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRows, setConfirmRows] = useState<LayoutRow[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Distinct doc types present among the layouts — drives the Type dropdown
  // (value = docType, label = its catalogue label, e.g. "Private Label"),
  // sorted by label so the menu reads alphabetically.
  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of layouts) if (!seen.has(l.docType)) seen.set(l.docType, l.docTypeLabel);
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [layouts]);

  // Customer / business-area options for the usage filters — drawn from the
  // Prod Specs that actually use each layout (l.prodSpecs), so a value only
  // appears if some layout is used under it. This is deliberately the usage
  // binding, not the layout's test-data customer/BA.
  const customerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of layouts) for (const ps of l.prodSpecs) {
      const v = ps.customerName.trim();
      if (v) set.add(v);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [layouts]);

  const baOptions = useMemo(() => {
    const map = new Map<string, string>(); // value → display label
    for (const l of layouts) for (const ps of l.prodSpecs) {
      const v = baKey(ps.businessAreaName);
      if (!map.has(v)) map.set(v, v === BLANK_BA ? "(blank)" : ps.businessAreaName.trim());
    }
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) =>
        a.value === BLANK_BA ? 1 : b.value === BLANK_BA ? -1 : a.label.localeCompare(b.label),
      );
  }, [layouts]);

  // Search across everything a row shows or links to: layout name/type,
  // test-data customer, the prod specs (+ their customers) using the
  // layout, and the (capped) style list — so "which layout prints style
  // X / customer Y" is findable from here. The dropdown filters (type /
  // status / auto-approve) and the search box all apply together.
  const q = query.trim().toLowerCase();
  const visibleLayouts = layouts.filter((l) => {
    if (typeFilter !== "all" && l.docType !== typeFilter) return false;
    if (statusFilter !== "all" && l.status !== statusFilter) return false;
    if (autoApproveFilter !== "all" && l.autoApprove !== (autoApproveFilter === "on")) return false;
    // "Used in a prod spec" = carried as an enabled output by ≥1 spec.
    if (usageFilter === "used" && l.prodSpecs.length === 0) return false;
    if (usageFilter === "unused" && l.prodSpecs.length > 0) return false;
    // Customer / BA match if ANY using spec carries that value.
    if (customerFilter !== "all" && !l.prodSpecs.some((s) => s.customerName.trim() === customerFilter))
      return false;
    if (baFilter !== "all" && !l.prodSpecs.some((s) => baKey(s.businessAreaName) === baFilter))
      return false;
    if (
      q &&
      ![
        l.name,
        l.docType,
        l.docTypeLabel,
        l.customerName ?? "",
        l.businessAreaName ?? "",
        ...l.prodSpecs.flatMap((s) => [s.name, s.customerName, s.businessAreaName]),
        ...l.styles.map((s) => s.name),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });
  const filtersActive =
    q !== "" ||
    typeFilter !== "all" ||
    statusFilter !== "all" ||
    autoApproveFilter !== "all" ||
    usageFilter !== "all" ||
    customerFilter !== "all" ||
    baFilter !== "all";

  function toggleOne(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allVisibleSelected = visibleLayouts.length > 0 && visibleLayouts.every((l) => selected.has(l.id));
  const someVisibleSelected = visibleLayouts.some((l) => selected.has(l.id));
  function toggleAllVisible() {
    setSelected((s) => {
      const next = new Set(s);
      if (allVisibleSelected) for (const l of visibleLayouts) next.delete(l.id);
      else for (const l of visibleLayouts) next.add(l.id);
      return next;
    });
  }

  // Union (deduped by id) of the prod specs across the rows queued for
  // deletion — exactly what loses this output. PDFs already generated are kept.
  const affectedSpecs = confirmRows
    ? [...new Map(confirmRows.flatMap((r) => r.prodSpecs).map((s) => [s.id, s])).values()]
    : [];

  async function createLayout() {
    setBusy("new");
    setError(null);
    try {
      const res = await fetch("/api/admin/output-layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: { id: string }; error?: string };
      if (!res.ok || !body.layout) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/output-builder/${body.layout.id}`);
    } finally {
      setBusy(null);
    }
  }

  async function duplicateLayout(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/output-layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duplicateFromId: id }),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: { id: string }; error?: string };
      if (!res.ok || !body.layout) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/output-builder/${body.layout.id}`);
    } finally {
      setBusy(null);
    }
  }

  // Delete the queued rows via the bulk endpoint (works for one id too). The
  // server cleanly drops each layout from any prod spec referencing it and
  // keeps already-generated PDFs.
  async function deleteConfirmed() {
    if (!confirmRows || confirmRows.length === 0) return;
    const ids = confirmRows.map((r) => r.id);
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/output-layouts/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setSelected(new Set());
      setConfirmRows(null);
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="px-8 py-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Output builder</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Build simple prints as configuration — corner-anchored text and barcodes with{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs">{"{{variables}}"}</code>. Published
            layouts appear in the Prod Spec output picker; they only generate once linked there.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DocTypesButton
            initialTypes={docTypes}
            fields={exclusionFields}
            defaultOpen={openDocTypes}
          />
          <button
            type="button"
            onClick={createLayout}
            disabled={busy !== null}
            className="rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            {busy === "new" ? "Creating…" : "New layout"}
          </button>
        </div>
      </div>

      {tabs}

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-zinc-200 bg-white px-5 py-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Logos</div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600">Contrast</span>
          {contrastLogoFound ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              found · {"{{logo:contrast}}"}
            </span>
          ) : (
            <span
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              title="Commit the logo file to the repo — no code change needed"
            >
              add <code className="font-mono">public/logos/contrast.svg</code> to the repo
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600">Contrast (address)</span>
          {contrastAddressLogoFound ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              found · {"{{logo:contrastAddress}}"}
            </span>
          ) : (
            <span
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              title="Commit the logo file to the repo — no code change needed"
            >
              add <code className="font-mono">public/logos/contrast-address.svg</code> to the repo
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          <span className="text-zinc-600">{"{{logo:custom}}"}</span> is now uploaded per layout — open a
          layout and use it where the token appears.
        </div>
      </div>

      {layouts.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 bg-white px-8 py-16 text-center">
          <p className="text-sm font-medium text-zinc-700">No layouts yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Start with “New layout”, set the physical size, drop text into the corners and watch it render on a real
            style.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search layouts — name, customer, prod spec, style…"
              className="w-full max-w-md flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
              spellCheck={false}
            />
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
              title="Filter by document type"
            >
              <option value="all">All types</option>
              {typeOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
              title="Filter by status"
            >
              <option value="all">All statuses</option>
              <option value="PUBLISHED">Published</option>
              <option value="DRAFT">Draft</option>
            </select>
            <select
              value={autoApproveFilter}
              onChange={(e) => setAutoApproveFilter(e.target.value as typeof autoApproveFilter)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
              title="Filter by auto-approve"
            >
              <option value="all">Auto-approve: any</option>
              <option value="on">Auto-approve: on</option>
              <option value="off">Auto-approve: off</option>
            </select>
            <select
              value={usageFilter}
              onChange={(e) => setUsageFilter(e.target.value as typeof usageFilter)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
              title="Filter by whether the layout is used as an enabled output in a prod spec"
            >
              <option value="all">In a prod spec: any</option>
              <option value="used">In a prod spec: yes</option>
              <option value="unused">In a prod spec: no</option>
            </select>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
              title="Filter by the customer of the prod specs using this layout"
              disabled={customerOptions.length === 0}
            >
              <option value="all">All customers</option>
              {customerOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={baFilter}
              onChange={(e) => setBaFilter(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none disabled:opacity-50"
              title="Filter by the business area of the prod specs using this layout"
              disabled={baOptions.length === 0}
            >
              <option value="all">All business areas</option>
              {baOptions.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
            {filtersActive ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setTypeFilter("all");
                  setStatusFilter("all");
                  setAutoApproveFilter("all");
                  setUsageFilter("all");
                  setCustomerFilter("all");
                  setBaFilter("all");
                }}
                className="text-xs text-zinc-400 hover:text-zinc-700"
              >
                Clear
              </button>
            ) : null}
            <span className="ml-auto text-xs text-zinc-400">
              {visibleLayouts.length} of {layouts.length}
            </span>
          </div>

          {selected.size > 0 ? (
            <div className="mt-4 flex items-center justify-between rounded-lg border border-zinc-300 bg-white px-4 py-2.5 shadow-sm">
              <span className="text-sm font-medium text-zinc-700">{selected.size} selected</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-800"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRows(layouts.filter((l) => selected.has(l.id)))}
                  disabled={busy !== null}
                  className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  Delete selected
                </button>
              </div>
            </div>
          ) : null}
          {visibleLayouts.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-300 bg-white px-8 py-12 text-center text-sm text-zinc-500">
              No layouts match the current filters.
            </div>
          ) : (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="w-10 rounded-tl-lg bg-zinc-50 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all layouts"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                  />
                </th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Layout</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Type</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Pages</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Generations</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Prod specs</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Styles</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Updated</th>
                <th className="rounded-tr-lg bg-zinc-50 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleLayouts.map((l) => (
                <tr
                  key={l.id}
                  className={`border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50/60 ${
                    selected.has(l.id) ? "bg-zinc-50" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.name}`}
                      checked={selected.has(l.id)}
                      onChange={() => toggleOne(l.id)}
                      className="h-3.5 w-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          l.status === "PUBLISHED" ? "bg-emerald-500" : "bg-zinc-300"
                        }`}
                        title={l.status === "PUBLISHED" ? `Published · v${l.version}` : "Draft"}
                      />
                      <Link href={`/output-builder/${l.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                        {l.name}
                      </Link>
                      {l.autoApprove ? (
                        <span
                          className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                          title="Outputs skip the manual review queue (a person still sends to the supplier)"
                        >
                          Auto-approve
                        </span>
                      ) : null}
                    </div>
                    <div className="ml-4 mt-0.5 font-mono text-xs text-zinc-400">layout:{l.id.slice(0, 10)}…</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                      {l.docTypeLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.defInvalid ? <span className="text-amber-600">invalid</span> : l.pageCount}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.generationCount === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <>
                        <span className="font-medium tabular-nums text-zinc-800">{l.generationCount}</span>
                        {l.lastGeneratedAt ? (
                          <div className="mt-0.5 text-xs text-zinc-400">
                            last {new Date(l.lastGeneratedAt).toLocaleDateString()}
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.prodSpecs.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <HoverPopover trigger={`${l.prodSpecs.length} prod spec${l.prodSpecs.length === 1 ? "" : "s"}`}>
                        <ul className="space-y-1.5 text-xs">
                          {l.prodSpecs.map((s) => (
                            <li key={s.id}>
                              <Link href={`/prod-specs/${s.id}`} className="font-medium text-zinc-800 hover:underline">
                                {s.name}
                              </Link>
                              <div className="text-zinc-500">{s.customerName}</div>
                            </li>
                          ))}
                        </ul>
                      </HoverPopover>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.styleCount === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <HoverPopover trigger={`${l.styleCount} style${l.styleCount === 1 ? "" : "s"}`}>
                        <ul className="space-y-1 text-xs">
                          {l.styles.map((s) => (
                            <li key={s.id}>
                              <Link href={`/styles/${s.id}`} className="text-zinc-700 hover:underline">
                                {s.name}
                              </Link>
                            </li>
                          ))}
                          {l.styleCount > l.styles.length ? (
                            <li className="pt-0.5 text-zinc-400">+{l.styleCount - l.styles.length} more</li>
                          ) : null}
                        </ul>
                      </HoverPopover>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-500">{new Date(l.updatedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => duplicateLayout(l.id)}
                        disabled={busy !== null}
                        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRows([l])}
                        disabled={busy !== null}
                        className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-400 hover:border-red-200 hover:text-red-600 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          )}
        </>
      )}

      {confirmRows ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deleting) setConfirmRows(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                {confirmRows.length === 1 ? `Delete “${confirmRows[0].name}”?` : `Delete ${confirmRows.length} layouts?`}
              </h2>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-zinc-600">
              {confirmRows.length > 1 ? (
                <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs">
                  {confirmRows.map((r) => (
                    <li key={r.id} className="truncate">
                      {r.name}
                      {r.status === "PUBLISHED" ? <span className="text-emerald-600"> · published</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {affectedSpecs.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  <p className="font-medium">
                    Removes the output from {affectedSpecs.length} prod spec{affectedSpecs.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {affectedSpecs.slice(0, 8).map((s) => (
                      <li key={s.id} className="truncate">
                        {s.name} <span className="text-amber-600">· {s.customerName}</span>
                      </li>
                    ))}
                    {affectedSpecs.length > 8 ? (
                      <li className="text-amber-600">+{affectedSpecs.length - 8} more</li>
                    ) : null}
                  </ul>
                </div>
              ) : (
                <p className="text-zinc-500">Not linked to any prod spec.</p>
              )}
              <p className="text-xs text-zinc-400">
                Already-generated PDFs are kept — only the prod-spec link is removed.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setConfirmRows(null)}
                disabled={deleting}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteConfirmed}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? "Deleting…" : confirmRows.length === 1 ? "Delete" : `Delete ${confirmRows.length}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
