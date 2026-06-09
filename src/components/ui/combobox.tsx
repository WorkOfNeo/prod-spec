"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Reusable searchable single- or multi-select. No external deps — uses
// a tiny popover bound to the trigger button and a controlled search
// input. Designed for the prod-spec dialog (Customer single, BA multi)
// but generic enough for other admin pickers (BusinessArea editor,
// supplier picker, etc.).
//
// Each option carries an optional `hint` we render right-aligned in the
// list — used by the prod-spec dialog to surface "47 items in data" /
// "already linked" badges next to each candidate.

export type ComboboxOption = {
  value: string;
  label: string;
  hint?: React.ReactNode;
  // When true the option still renders but the user can't toggle it on.
  // We use this to grey out (Customer × BA) combos that already exist.
  disabled?: boolean;
  // Tooltip shown on hover when disabled — explains *why*.
  disabledReason?: string;
};

type CommonProps = {
  options: ComboboxOption[];
  placeholder?: string;
  // Empty state shown when the search filters out everything.
  emptyLabel?: string;
  // Optional id so a parent <label> can point at the trigger button.
  id?: string;
  disabled?: boolean;
};

type SingleProps = CommonProps & {
  mode?: "single";
  value: string | null;
  onChange: (value: string | null) => void;
  // Hide the clear-selection ✕ button.
  clearable?: boolean;
};

type MultiProps = CommonProps & {
  mode: "multi";
  value: string[];
  onChange: (value: string[]) => void;
  // Cap the visible chip pile inside the trigger — overflow gets a
  // "+N" badge. Defaults to 3.
  maxChipsShown?: number;
};

export function Combobox(props: SingleProps | MultiProps) {
  const { options, placeholder = "Select…", emptyLabel = "No matches", id, disabled } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter once per query change. Substring match, case-insensitive,
  // checks label only — hint isn't searchable (it's metadata).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Reset active index when query/open changes. Done during render
  // (React 19 idiom — avoids setState-in-effect lint and re-fires
  // immediately rather than on the next paint).
  const [lastQuery, setLastQuery] = useState(query);
  const [lastOpen, setLastOpen] = useState(open);
  if (lastQuery !== query || lastOpen !== open) {
    setLastQuery(query);
    setLastOpen(open);
    setActiveIdx(0);
  }

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        popoverRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Single-select label rendering.
  function renderSingleTrigger() {
    const p = props as SingleProps;
    const selected = p.value ? options.find((o) => o.value === p.value) : null;
    return (
      <span className="flex flex-1 items-center justify-between gap-2 min-w-0">
        <span className={`truncate ${selected ? "text-zinc-900" : "text-zinc-400"}`}>
          {selected ? selected.label : placeholder}
        </span>
        {selected && p.clearable !== false && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              p.onChange(null);
            }}
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Clear selection"
          >
            ×
          </span>
        )}
      </span>
    );
  }

  // Multi-select chips with overflow badge.
  function renderMultiTrigger() {
    const p = props as MultiProps;
    const max = p.maxChipsShown ?? 3;
    const selectedOptions = options.filter((o) => p.value.includes(o.value));
    if (selectedOptions.length === 0) {
      return <span className="truncate text-zinc-400">{placeholder}</span>;
    }
    const visible = selectedOptions.slice(0, max);
    const overflow = selectedOptions.length - visible.length;
    return (
      <span className="flex flex-1 flex-wrap items-center gap-1 min-w-0">
        {visible.map((o) => (
          <span
            key={o.value}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
          >
            {o.label}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                p.onChange(p.value.filter((v) => v !== o.value));
              }}
              className="ml-0.5 text-zinc-400 hover:text-zinc-700"
              aria-label={`Remove ${o.label}`}
            >
              ×
            </span>
          </span>
        ))}
        {overflow > 0 && (
          <span className="text-xs text-zinc-500">+{overflow}</span>
        )}
      </span>
    );
  }

  function toggleOption(o: ComboboxOption) {
    if (o.disabled) return;
    if (props.mode === "multi") {
      const p = props as MultiProps;
      const has = p.value.includes(o.value);
      p.onChange(has ? p.value.filter((v) => v !== o.value) : [...p.value, o.value]);
    } else {
      const p = props as SingleProps;
      p.onChange(o.value);
      setOpen(false);
    }
  }

  function isSelected(o: ComboboxOption): boolean {
    if (props.mode === "multi") {
      return (props as MultiProps).value.includes(o.value);
    }
    return (props as SingleProps).value === o.value;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[activeIdx];
      if (o) toggleOption(o);
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="flex w-full items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-left text-sm text-zinc-700 hover:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {props.mode === "multi" ? renderMultiTrigger() : renderSingleTrigger()}
        <svg
          className="h-4 w-4 flex-shrink-0 text-zinc-400"
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
          className="absolute z-50 mt-1 max-h-72 w-full overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg"
          role="listbox"
        >
          <div className="border-b border-zinc-100 px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              className="w-full rounded-sm bg-zinc-50 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-300"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-zinc-500">{emptyLabel}</li>
            ) : (
              filtered.map((o, idx) => {
                const selected = isSelected(o);
                const active = idx === activeIdx;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={o.disabled || undefined}
                      title={o.disabled ? o.disabledReason : undefined}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => toggleOption(o)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm ${
                        o.disabled
                          ? "cursor-not-allowed text-zinc-400"
                          : active
                            ? "bg-zinc-100 text-zinc-900"
                            : "text-zinc-800 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {props.mode === "multi" && (
                          <span
                            className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border ${
                              selected
                                ? "border-zinc-900 bg-zinc-900 text-white"
                                : "border-zinc-300"
                            }`}
                            aria-hidden="true"
                          >
                            {selected && (
                              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                                <path d="M4.5 8.5L2 6l-1 1 3.5 3.5L11 4 10 3z" />
                              </svg>
                            )}
                          </span>
                        )}
                        <span className="truncate">{o.label}</span>
                        {props.mode === "single" && selected && (
                          <span className="text-xs text-zinc-400">selected</span>
                        )}
                      </span>
                      {o.hint && <span className="flex-shrink-0 text-xs text-zinc-500">{o.hint}</span>}
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
