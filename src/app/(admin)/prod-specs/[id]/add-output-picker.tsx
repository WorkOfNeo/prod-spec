"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LazyOutputPreview } from "@/components/output-preview";

// =====================================================
// Add-output picker — the catalogue browser the ProdSpec editor expands
// to attach a new output. Replaces the old bare <details> grid with a
// proper search box, docType + source filters, type-badged cards, and an
// on-demand live preview per card (reusing the same preview endpoint the
// added outputs use). Self-contained client component; the editor owns
// the actual `outputs` state and passes only the UNADDED variants here.
// =====================================================

export type VariantInfo = {
  key: string;
  docType: string;
  name: string;
  description: string;
  defaultWidthMm: number;
  defaultHeightMm: number;
};

type Source = "builtin" | "layout";

// Human label per DocType (the enum values are SHOUTY_SNAKE).
const DOC_TYPE_LABEL: Record<string, string> = {
  WASHCARE: "Wash care",
  CARE_LABEL: "Care label",
  STICKER: "Sticker",
  HANGTAG: "Hang tag",
  CARTON_MARKING: "Carton marking",
  COLOUR_STICKER: "Colour sticker",
};

// Subtle per-type badge colours. Literal class strings (not constructed)
// so Tailwind's scanner keeps them.
const DOC_TYPE_BADGE: Record<string, string> = {
  WASHCARE: "border-sky-200 bg-sky-50 text-sky-700",
  CARE_LABEL: "border-indigo-200 bg-indigo-50 text-indigo-700",
  STICKER: "border-violet-200 bg-violet-50 text-violet-700",
  HANGTAG: "border-amber-200 bg-amber-50 text-amber-700",
  CARTON_MARKING: "border-teal-200 bg-teal-50 text-teal-700",
  COLOUR_STICKER: "border-rose-200 bg-rose-50 text-rose-700",
};

const FALLBACK_BADGE = "border-zinc-200 bg-zinc-100 text-zinc-600";

function docLabel(docType: string): string {
  return DOC_TYPE_LABEL[docType] ?? docType;
}

function sourceOf(key: string): Source {
  return key.startsWith("layout:") ? "layout" : "builtin";
}

const SOURCE_LABEL: Record<Source, string> = {
  builtin: "Built-in",
  layout: "Builder",
};

type Props = {
  // The variants NOT yet added to this spec — the editor recomputes this
  // as outputs are added/removed, so an added card simply drops out.
  variants: VariantInfo[];
  // For building preview URLs against this spec's configuration.
  prodSpecId: string;
  onAdd: (variant: VariantInfo) => void;
  // Bumped by the editor after each autosave so open previews refetch
  // with the latest logo / languages / care config.
  previewRefreshKey?: string;
};

export function AddOutputPicker({ variants, prodSpecId, onAdd, previewRefreshKey }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [docFilter, setDocFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | Source>("all");
  const [previewKeys, setPreviewKeys] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search box when the picker opens — straight to typing.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Which docTypes / sources actually exist in the current catalogue, so
  // we only render filters that can match something.
  const docTypesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const v of variants) set.add(v.docType);
    return [...set].sort((a, b) => docLabel(a).localeCompare(docLabel(b)));
  }, [variants]);

  const sourcesPresent = useMemo(() => {
    const set = new Set<Source>();
    for (const v of variants) set.add(sourceOf(v.key));
    return set;
  }, [variants]);

  // Pre-built lowercase search blob per variant: name + key + docType
  // (raw + label) + description. One substring check per row.
  const indexed = useMemo(
    () =>
      variants.map((v) => ({
        v,
        source: sourceOf(v.key),
        blob: `${v.name} ${v.key} ${v.docType} ${docLabel(v.docType)} ${v.description}`.toLowerCase(),
      })),
    [variants],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return indexed.filter(({ v, source, blob }) => {
      if (docFilter !== "all" && v.docType !== docFilter) return false;
      if (sourceFilter !== "all" && source !== sourceFilter) return false;
      if (q && !blob.includes(q)) return false;
      return true;
    });
  }, [indexed, query, docFilter, sourceFilter]);

  function togglePreview(key: string) {
    setPreviewKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function resetFilters() {
    setQuery("");
    setDocFilter("all");
    setSourceFilter("all");
  }

  const hasFilters = query.trim() !== "" || docFilter !== "all" || sourceFilter !== "all";

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-100"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Chevron open={open} />
          Add output
          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
            {variants.length} available
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-200 bg-white p-3">
          {/* Search */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="m17 17-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (query) setQuery("");
                  else setOpen(false);
                }
              }}
              placeholder="Search by name, type, key…"
              className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-9 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                title="Clear search"
                aria-label="Clear search"
              >
                ✕
              </button>
            ) : null}
          </div>

          {/* Filters */}
          {(docTypesPresent.length > 1 || sourcesPresent.size > 1) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {docTypesPresent.length > 1 && (
                <>
                  <FilterChip active={docFilter === "all"} onClick={() => setDocFilter("all")}>
                    All types
                  </FilterChip>
                  {docTypesPresent.map((dt) => (
                    <FilterChip key={dt} active={docFilter === dt} onClick={() => setDocFilter(dt)}>
                      {docLabel(dt)}
                    </FilterChip>
                  ))}
                </>
              )}
              {sourcesPresent.size > 1 && (
                <>
                  <span className="mx-1 h-4 w-px bg-zinc-200" aria-hidden="true" />
                  <FilterChip active={sourceFilter === "all"} onClick={() => setSourceFilter("all")}>
                    All sources
                  </FilterChip>
                  <FilterChip
                    active={sourceFilter === "builtin"}
                    onClick={() => setSourceFilter("builtin")}
                  >
                    Built-in
                  </FilterChip>
                  <FilterChip
                    active={sourceFilter === "layout"}
                    onClick={() => setSourceFilter("layout")}
                  >
                    Builder
                  </FilterChip>
                </>
              )}
            </div>
          )}

          {/* Result count */}
          <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-400">
            <span>
              {filtered.length === variants.length
                ? `${variants.length} output${variants.length === 1 ? "" : "s"}`
                : `${filtered.length} of ${variants.length}`}
            </span>
            {hasFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="font-medium text-zinc-500 underline hover:text-zinc-800"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Cards */}
          {filtered.length === 0 ? (
            <div className="mt-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
              No outputs match{query.trim() ? ` “${query.trim()}”` : " these filters"}.
            </div>
          ) : (
            <div className="mt-2 grid max-h-[28rem] grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
              {filtered.map(({ v, source }) => {
                const previewOpen = previewKeys.has(v.key);
                return (
                  <div
                    key={v.key}
                    className="flex flex-col rounded-lg border border-zinc-200 bg-white transition hover:border-zinc-400 hover:shadow-sm"
                  >
                    <button
                      type="button"
                      onClick={() => onAdd(v)}
                      className="group rounded-t-lg p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                      title={`Add “${v.name}”`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 text-sm font-medium text-zinc-900">{v.name}</div>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            DOC_TYPE_BADGE[v.docType] ?? FALLBACK_BADGE
                          }`}
                        >
                          {docLabel(v.docType)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
                        {v.key}
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-zinc-500">{v.description}</div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-zinc-400">
                          {v.defaultWidthMm}×{v.defaultHeightMm} mm · {SOURCE_LABEL[source]}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white opacity-90 transition group-hover:opacity-100">
                          + Add
                        </span>
                      </div>
                    </button>

                    {/* On-demand preview — sample data wearing this spec's
                        config. Lazy: only fetches once expanded and scrolled
                        into view. */}
                    <div className="border-t border-zinc-100">
                      <button
                        type="button"
                        onClick={() => togglePreview(v.key)}
                        className="flex w-full items-center gap-1 px-3 py-1.5 text-[11px] font-medium text-zinc-400 hover:text-zinc-700"
                        aria-expanded={previewOpen}
                      >
                        <Chevron open={previewOpen} small />
                        {previewOpen ? "Hide preview" : "Preview"}
                      </button>
                      {previewOpen && (
                        <div className="px-3 pb-3">
                          <div className="rounded-md bg-zinc-100 p-2">
                            <LazyOutputPreview
                              src={`/api/admin/prod-specs/${prodSpecId}/output-preview?variantKey=${encodeURIComponent(v.key)}`}
                              widthMm={v.defaultWidthMm}
                              heightMm={v.defaultHeightMm}
                              refreshKey={previewRefreshKey}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function Chevron({ open, small }: { open: boolean; small?: boolean }) {
  return (
    <svg
      className={`${small ? "h-3 w-3" : "h-4 w-4"} text-zinc-400 transition-transform ${
        open ? "rotate-90" : ""
      }`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7 5l5 5-5 5V5z" />
    </svg>
  );
}
