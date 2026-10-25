"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type FacetOption = { value: string; label: string; count: number };

// A single faceted-filter dropdown for a table filter bar: a trigger
// button (facet name + selected-count badge) opening a popover with an
// optional search-within box and a scrollable checkbox list. Each option
// shows how many loaded rows currently carry that value. Shared across the
// /styles and /prod-specs lists.
//
// Selection is controlled by the parent: toggling a box calls onChange.
// Some callers commit immediately to the table (/prod-specs); others hold a
// DRAFT and only apply on an explicit Apply (see styles-table.tsx).
// Click-outside / Escape just close the popover; they neither apply nor
// revert. Built on the same lightweight popover idiom as ui/combobox.tsx.
export function FacetFilter({
  label,
  options,
  selected,
  onChange,
  searchable,
  wide,
  wrapOptions,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  // Show the search-within box. Defaults on when there are >8 options.
  searchable?: boolean;
  // Wider popover — for long values (e.g. rejection comments) that need room
  // to breathe instead of the default narrow facet width.
  wide?: boolean;
  // Wrap each option's label across lines instead of truncating it. Collapsed
  // to ~6 lines; hovering a row for 3s animates it open to its full height
  // (and back when the cursor leaves). For long free-text values like comments.
  wrapOptions?: boolean;
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
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
          count > 0
            ? "border-accent bg-accent-soft text-accent-text"
            : "border-line bg-surface text-ink hover:bg-subtle"
        }`}
      >
        {label}
        {count > 0 && <span className="tabular-nums opacity-80">· {count}</span>}
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
          className={`border-line bg-surface absolute left-0 z-50 mt-1 overflow-hidden rounded-lg border shadow-[var(--shadow-pop)] ${
            wide ? "w-96" : "w-64"
          }`}
          role="listbox"
        >
          {showSearch && (
            <div className="border-line border-b px-2 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="bg-subtle text-ink placeholder:text-faint w-full rounded-md px-2 py-1 text-[13px] outline-none"
              />
            </div>
          )}
          <div className="text-muted flex items-center justify-between px-3 py-1.5 text-[11px]">
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
          <ul
            className={`border-line overflow-y-auto border-t py-1 ${
              wrapOptions ? "max-h-[28rem]" : "max-h-60"
            }`}
          >
            {filtered.length === 0 ? (
              <li className="text-muted px-3 py-2 text-[12px]">No matches</li>
            ) : (
              filtered.map((o) => (
                <OptionRow
                  key={o.value}
                  option={o}
                  checked={selectedSet.has(o.value)}
                  onToggle={() => toggle(o.value)}
                  wrap={wrapOptions === true}
                />
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// A single option row. Default: one truncated line. With `wrap`, the label
// wraps across lines, collapsed to ~6 lines (max-height clip) — and hovering
// the row for 3s animates it open to its full height, collapsing back when the
// cursor leaves. The 3s dwell keeps a casual mouse-over from expanding rows;
// only a deliberate pause does.
function OptionRow({
  option,
  checked,
  onToggle,
  wrap,
}: {
  option: FacetOption;
  checked: boolean;
  onToggle: () => void;
  wrap: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Tidy the pending timer if the popover unmounts mid-dwell.
  useEffect(() => clear, []);

  const onEnter = () => {
    if (!wrap) return;
    clear();
    timer.current = setTimeout(() => setExpanded(true), 3000);
  };
  const onLeave = () => {
    if (!wrap) return;
    clear();
    setExpanded(false);
  };

  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={checked}
        onClick={onToggle}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`text-ink hover:bg-subtle flex w-full gap-2 px-3 py-1.5 text-left text-[13px] ${
          wrap ? "items-start" : "items-center"
        }`}
      >
        <span
          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border ${
            wrap ? "mt-0.5" : ""
          } ${checked ? "border-primary bg-primary text-primary-ink" : "border-line"}`}
          aria-hidden="true"
        >
          {checked && (
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
              <path d="M4.5 8.5L2 6l-1 1 3.5 3.5L11 4 10 3z" />
            </svg>
          )}
        </span>
        {wrap ? (
          <span
            // Clip to ~6 lines (6 × 1.25rem) and animate max-height on the 3s
            // hover expand. Generous ceiling so even long comments fully show.
            className={`min-w-0 flex-1 overflow-hidden whitespace-pre-wrap break-words leading-5 transition-[max-height] duration-500 ease-in-out ${
              expanded ? "max-h-[60rem]" : "max-h-[7.5rem]"
            }`}
          >
            {option.label}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        )}
        <span className="text-faint flex-shrink-0 text-[12px] tabular-nums">{option.count}</span>
      </button>
    </li>
  );
}
