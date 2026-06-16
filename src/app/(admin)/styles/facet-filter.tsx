"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type FacetOption = { value: string; label: string; count: number };

// A single faceted-filter dropdown for the /styles filter bar: a trigger
// button (facet name + selected-count badge) opening a popover with an
// optional search-within box and a scrollable checkbox list. Each option
// shows how many loaded rows currently carry that value.
//
// Selection is a DRAFT — toggling a box calls onChange, but the parent only
// commits it to the table on an explicit Apply (see styles-table.tsx).
// Click-outside / Escape just close the popover; they neither apply nor
// revert. Built on the same lightweight popover idiom as ui/combobox.tsx.
export function FacetFilter({
  label,
  options,
  selected,
  onChange,
  searchable,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  // Show the search-within box. Defaults on when there are >8 options.
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showSearch = searchable ?? options.length > 8;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const count = selected.length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && showSearch) inputRef.current?.focus();
  }, [open, showSearch]);

  function toggle(value: string) {
    onChange(
      selectedSet.has(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          count > 0
            ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800"
            : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        {label}
        {count > 0 && <span className="tabular-nums text-zinc-300">· {count}</span>}
        <svg
          className="h-3.5 w-3.5 opacity-70"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M5.5 7l4.5 5 4.5-5h-9z" />
        </svg>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg"
          role="listbox"
        >
          {showSearch && (
            <div className="border-b border-zinc-100 px-2 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="w-full rounded-sm bg-zinc-50 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-300"
              />
            </div>
          )}
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-zinc-500">
            <span className="tabular-nums">{count} selected</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChange(options.map((o) => o.value))}
                className="underline hover:text-zinc-700"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={count === 0}
                className="underline hover:text-zinc-700 disabled:text-zinc-300 disabled:no-underline"
              >
                None
              </button>
            </div>
          </div>
          <ul className="max-h-60 overflow-y-auto border-t border-zinc-100 py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-zinc-500">No matches</li>
            ) : (
              filtered.map((o) => {
                const checked = selectedSet.has(o.value);
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      onClick={() => toggle(o.value)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-50"
                    >
                      <span
                        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border ${
                          checked
                            ? "border-zinc-900 bg-zinc-900 text-white"
                            : "border-zinc-300"
                        }`}
                        aria-hidden="true"
                      >
                        {checked && (
                          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                            <path d="M4.5 8.5L2 6l-1 1 3.5 3.5L11 4 10 3z" />
                          </svg>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      <span className="flex-shrink-0 tabular-nums text-xs text-zinc-400">
                        {o.count}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
