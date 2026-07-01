"use client";

// Filtered table for /prod-specs. Receives the full row set from the server
// component once; filters in-browser. With ~75 rows today (and growing
// slowly), client-side filtering is instant — no re-query on filter change.
//
// Filters: a free-text search box plus Customer / Business area faceted
// dropdowns (multi-select, OR within a facet, AND across facets — same
// FacetFilter as /styles) and a tri-state "General info" presence chip.
// All four round-trip through the URL (shallow replaceState) so the active
// filter survives Back from a prod-spec detail page.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SkipSupplierDeliveryBadge } from "@/components/skip-supplier-delivery-badge";
import { FacetFilter, type FacetOption } from "@/components/facet-filter";
import { BLANK_BA_VALUES } from "@/lib/import/heuristics";

export type ProdSpecRow = {
  id: string;
  name: string;
  customerName: string;
  // Customer.config.skipSupplierDelivery — "Delivers own" chip beside the
  // customer so the spec isn't read as one that sends supplier delivery.
  customerDeliversOwn: boolean;
  businessAreaName: string;
  businessAreaMondayValue: string;
  // Whether the "General information" A4 page markdown (ProdSpec.generalInfoMd)
  // has any content — drives the "General info" presence filter.
  hasGeneralInfo: boolean;
  // The custom outputs configured on this prod spec, resolved to display
  // names server-side. `enabled: false` outputs are shown muted.
  outputs: Array<{ key: string; name: string; enabled: boolean }>;
  supplierCount: number;
  styleCount: number;
  jobCount: number;
  autoGenerateThresholdPct: number;
  active: boolean;
  fullyApproved: boolean;
  updatedAt: string;
  // Pre-built lower-case search blob so filtering is one substring check
  // per row regardless of how many fields we include in the search.
  searchBlob: string;
};

// Sentinel so blank / "–" business areas collapse into one selectable
// "(blank)" option instead of vanishing. Plain ASCII (never a control char)
// so it can't turn a saved value binary — see avoid-control-char-sentinels.
const BLANK_VALUE = "__blank__";

type TriState = "any" | "has" | "no";
const NEXT_STATE: Record<TriState, TriState> = { any: "has", has: "no", no: "any" };

function customerValue(r: ProdSpecRow): string {
  return r.customerName.trim() || BLANK_VALUE;
}
// Resolved BA can literally be "–" on the live DB (blank-named areas), so
// blank-check the name itself, not just empty string.
function baValue(r: ProdSpecRow): string {
  const t = r.businessAreaName.trim();
  return BLANK_BA_VALUES.has(t) ? BLANK_VALUE : t;
}

export function ProdSpecsTable({ rows }: { rows: ProdSpecRow[] }) {
  // Seed the filter state from the URL once, on mount; thereafter state is the
  // source of truth and flows state → URL (the effect below). Read via
  // useSearchParams (not window) so it's SSR-safe.
  const searchParams = useSearchParams();
  const seed = useMemo(
    () => ({
      q: searchParams.get("q") ?? "",
      customer: searchParams.getAll("customer"),
      ba: searchParams.getAll("ba"),
      gi: ((): TriState => {
        const v = searchParams.get("gi");
        return v === "has" || v === "no" ? v : "any";
      })(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
    [],
  );

  const [q, setQ] = useState(seed.q);
  // Customer / Business area selections apply to the table immediately (the
  // ~75-row filter is instant — no Apply button needed, unlike /styles).
  const [customerSel, setCustomerSel] = useState<string[]>(seed.customer);
  const [baSel, setBaSel] = useState<string[]>(seed.ba);
  const [giState, setGiState] = useState<TriState>(seed.gi);

  // Persist the active filter to the URL with a *shallow* replaceState — no
  // router navigation, so the page's server query never re-runs as the user
  // types or picks facets, and (replace, not push) keystrokes don't each
  // become a history entry. Facet values are real data, so each selection is
  // its own repeated key (?customer=Netto&customer=Børn).
  useEffect(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q);
    for (const v of customerSel) params.append("customer", v);
    for (const v of baSel) params.append("ba", v);
    if (giState !== "any") params.set("gi", giState);
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [q, customerSel, baSel, giState]);

  // Distinct option lists (+counts) per facet, derived once from the loaded
  // rows — a value only appears if a real spec carries it. Blank-last sort.
  const { customerOptions, baOptions } = useMemo(() => {
    const customer = new Map<string, number>();
    const ba = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of rows) {
      bump(customer, customerValue(r));
      bump(ba, baValue(r));
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
    return { customerOptions: alpha(customer), baOptions: alpha(ba) };
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cSet = customerSel.length ? new Set(customerSel) : null;
    const bSet = baSel.length ? new Set(baSel) : null;
    return rows.filter((r) => {
      if (cSet && !cSet.has(customerValue(r))) return false;
      if (bSet && !bSet.has(baValue(r))) return false;
      if (giState === "has" && !r.hasGeneralInfo) return false;
      if (giState === "no" && r.hasGeneralInfo) return false;
      if (!needle) return true;
      return r.searchBlob.includes(needle);
    });
  }, [rows, q, customerSel, baSel, giState]);

  const anyFilterActive =
    customerSel.length > 0 || baSel.length > 0 || giState !== "any";

  function clearFilters() {
    setCustomerSel([]);
    setBaSel([]);
    setGiState("any");
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, customer, or business area…"
            className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <span className="text-xs tabular-nums text-zinc-500">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Filter by</span>
        <FacetFilter
          label="Customer"
          options={customerOptions}
          selected={customerSel}
          onChange={setCustomerSel}
        />
        <FacetFilter
          label="Business area"
          options={baOptions}
          selected={baSel}
          onChange={setBaSel}
        />
        <FilterChip
          label="General info"
          state={giState}
          onClick={() => setGiState((s) => NEXT_STATE[s])}
        />
        {anyFilterActive && (
          <button
            type="button"
            onClick={clearFilters}
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
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Business area</th>
              <th
                className="px-4 py-3"
                title="Whether the General information A4 page has any content."
              >
                General info
              </th>
              <th className="px-4 py-3">Outputs</th>
              <th className="px-4 py-3">Suppliers</th>
              <th className="px-4 py-3">Styles</th>
              <th
                className="px-4 py-3"
                title="Generation jobs tied to this prod spec (analytics)."
              >
                Jobs
              </th>
              <th className="px-4 py-3">Threshold</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Fully approved</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-zinc-500">
                  {rows.length === 0
                    ? "No prod specs yet. They auto-create when the first Style ingests with a known customer × business area pair."
                    : "No prod specs match the current search or filters."}
                </td>
              </tr>
            ) : (
              filtered.map((ps) => (
                <tr
                  key={ps.id}
                  className={`border-t border-zinc-100 hover:bg-zinc-50 ${
                    ps.active ? "" : "opacity-50"
                  }`}
                >
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/prod-specs/${ps.id}`} className="hover:underline">
                      {ps.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <span className="flex items-center gap-1.5">
                      {ps.customerName}
                      {ps.customerDeliversOwn && <SkipSupplierDeliveryBadge variant="chip" />}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{ps.businessAreaName}</td>
                  <td className="px-4 py-3">
                    {ps.hasGeneralInfo ? (
                      <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        Yes
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {ps.outputs.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {ps.outputs.map((o) => (
                          <span
                            key={o.key}
                            title={o.enabled ? o.name : `${o.name} (disabled)`}
                            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${
                              o.enabled
                                ? "bg-zinc-100 text-zinc-700"
                                : "bg-zinc-50 text-zinc-400 line-through"
                            }`}
                          >
                            {o.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">
                    {ps.supplierCount}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{ps.styleCount}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">{ps.jobCount}</td>
                  <td className="px-4 py-3 tabular-nums text-zinc-600">
                    {ps.autoGenerateThresholdPct}%
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {ps.active ? "yes" : "no"}
                  </td>
                  <td className="px-4 py-3">
                    {ps.fullyApproved ? (
                      <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        Approved
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">{ps.updatedAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tri-state presence chip. Click cycles any → has → no → any. The label
// gains a "Has "/"No " prefix and a green/red tint to make the active
// direction obvious at a glance. Mirrors the /styles attribute chips.
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
