"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FacetFilter, type FacetOption } from "@/components/facet-filter";
import type {
  GenerationQueue,
  GenerationThroughput,
  StyleDashboardRow,
  StyleFacetState,
} from "@/lib/dashboard/style-dashboard";
import { DashboardTopBand } from "./dashboard-top-band";
import { StyleRow } from "./style-row";

const BLANK = "—"; // sentinel for a null customer / business area / supplier

const STATE_LABEL: Record<StyleFacetState, string> = {
  GENERATING: "Generating",
  TO_REVIEW: "To review",
  BLOCKED: "Blocked",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  // Synthetic — a declared output that produced no document at all.
  NOT_GENERATED: "Not generated",
  // Per-document states that only a generated asset can carry, so these never
  // reach the facet; listed for type completeness over the union.
  READY_TO_GENERATE: "Ready",
  AWAITING_DATA: "Missing fields",
  EXCLUDED: "Excluded",
};
const UPLOAD_LABEL: Record<string, string> = { uploaded: "Uploaded", "not-uploaded": "Not uploaded" };
const EMAIL_LABEL: Record<string, string> = { sent: "Sent", "not-sent": "Not sent" };

// Each facet: how to pull a row's values (multi-valued) and how to label them.
const FACETS: {
  key: string;
  label: string;
  values: (r: StyleDashboardRow) => string[];
  labelOf: (v: string) => string;
}[] = [
  { key: "customer", label: "Customer", values: (r) => [r.customer ?? BLANK], labelOf: (v) => v },
  { key: "ba", label: "Business area", values: (r) => [r.businessArea ?? BLANK], labelOf: (v) => v },
  { key: "supplier", label: "Supplier", values: (r) => [r.supplier ?? BLANK], labelOf: (v) => v },
  { key: "state", label: "Output state", values: (r) => r.states, labelOf: (v) => STATE_LABEL[v as StyleFacetState] ?? v },
  { key: "upload", label: "Upload", values: (r) => r.uploadStates, labelOf: (v) => UPLOAD_LABEL[v] ?? v },
  { key: "email", label: "Email", values: (r) => r.emailStates, labelOf: (v) => EMAIL_LABEL[v] ?? v },
];
const FACET_KEYS = FACETS.map((f) => f.key);

const RENDER_STEP = 40;

type Selected = Record<string, string[]>;

export function StyleDashboardClient({
  initialQueue,
  initialThroughput,
  rows,
}: {
  initialQueue: GenerationQueue;
  initialThroughput: GenerationThroughput;
  rows: StyleDashboardRow[];
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Selected>({});
  const [visibleCount, setVisibleCount] = useState(RENDER_STEP);
  const sentinel = useRef<HTMLDivElement>(null);
  // Every filter/search change also calls this to reset the lazy-render window
  // (kept in the handlers rather than an effect — no set-state-in-effect churn).
  const resetWindow = () => setVisibleCount(RENDER_STEP);

  // Facet options derived from the loaded rows, with live counts.
  const facetOptions = useMemo(() => {
    const out: Record<string, FacetOption[]> = {};
    for (const f of FACETS) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        for (const v of new Set(f.values(r))) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      out[f.key] = [...counts.entries()]
        .map(([value, count]) => ({ value, label: f.labelOf(value), count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }
    return out;
  }, [rows]);

  const tokens = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tokens.length && !tokens.every((t) => r.searchBlob.includes(t))) return false;
      for (const f of FACETS) {
        const sel = selected[f.key];
        if (!sel || sel.length === 0) continue;
        const vals = f.values(r);
        if (!vals.some((v) => sel.includes(v))) return false;
      }
      return true;
    });
  }, [rows, tokens, selected]);

  // Grow the rendered slice as the sentinel scrolls into view.
  //
  // `visibleCount` is deliberately NOT a dependency: re-creating the observer on
  // every bump makes it fire again immediately while the sentinel is still
  // inside rootMargin, which cascades — 40 → 80 → … → the whole list in one go,
  // re-rendering a growing list each step and locking the main thread. Keying on
  // `hasMore` attaches the observer once per lazy run, so it only fires on a real
  // intersection change (i.e. the user actually scrolling down to it); the
  // "Show more" button is the manual fallback.
  const hasMore = visibleCount < filtered.length;
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((v) => Math.min(v + RENDER_STEP, filtered.length));
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, filtered.length]);

  const activeFilters = tokens.length > 0 || FACET_KEYS.some((k) => (selected[k]?.length ?? 0) > 0);

  return (
    <>
      <DashboardTopBand initialQueue={initialQueue} initialThroughput={initialThroughput} />

      {/* Filter bar */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            resetWindow();
          }}
          placeholder="Search style, PO, customer, supplier, output…"
          className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-400"
        />
        {FACETS.map((f) => (
          <FacetFilter
            key={f.key}
            label={f.label}
            options={facetOptions[f.key] ?? []}
            selected={selected[f.key] ?? []}
            onChange={(next) => {
              setSelected((prev) => ({ ...prev, [f.key]: next }));
              resetWindow();
            }}
          />
        ))}
        {activeFilters && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setSelected({});
              resetWindow();
            }}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-xs tabular-nums text-zinc-500">
          {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} styles
        </span>
      </div>

      {/* Style list */}
      {filtered.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-16 text-center">
          <p className="text-sm font-medium text-zinc-700">
            {rows.length === 0 ? "No styles have generated outputs yet." : "No styles match these filters."}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {filtered.slice(0, visibleCount).map((r) => (
            <StyleRow key={r.styleId} row={r} />
          ))}
          {hasMore && (
            <div ref={sentinel} className="flex justify-center py-4">
              <button
                type="button"
                onClick={() => setVisibleCount((v) => Math.min(v + RENDER_STEP, filtered.length))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Show {Math.min(RENDER_STEP, filtered.length - visibleCount)} more
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
