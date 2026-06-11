"use client";

import { useEffect, useRef, useState } from "react";
import {
  STANDARD_VISIBLE,
  STYLE_TABLE_COLUMNS,
  type StyleColumnKey,
} from "@/lib/styles/table-columns";

// ADMIN-only "Columns" popover for the styles table. Toggles save the
// GLOBAL standard view (AppSetting, via the styles-table-columns route) —
// every user sees the result; this is not a per-browser preference.
// Optimistic: the table updates immediately and reverts if the save fails.
export function ColumnsPopover({
  visible,
  onChange,
}: {
  visible: StyleColumnKey[];
  onChange: (next: StyleColumnKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function save(next: StyleColumnKey[]) {
    const prev = visible;
    onChange(next); // optimistic — the table re-renders instantly
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/styles-table-columns", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: next }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        visible?: StyleColumnKey[];
      };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      // Adopt the server-normalized list (unknown keys dropped, locked forced on).
      if (Array.isArray(j.visible)) onChange(j.visible);
    } catch (e) {
      onChange(prev);
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const visibleSet = new Set(visible);
  const isStandard =
    visible.length === STANDARD_VISIBLE.length && STANDARD_VISIBLE.every((k) => visibleSet.has(k));

  function toggle(key: StyleColumnKey) {
    void save(visibleSet.has(key) ? visible.filter((k) => k !== key) : [...visible, key]);
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Choose which columns the styles table shows — for every user"
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
      >
        Columns ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-3 shadow-lg">
          <div className="text-xs font-semibold text-zinc-900">Table columns</div>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Standard view for every user — saves instantly.
          </p>
          <div className="mt-2">
            {STYLE_TABLE_COLUMNS.map((c) => (
              <label
                key={c.key}
                className={`flex items-center gap-2 py-1 text-xs ${
                  c.locked ? "text-zinc-400" : "cursor-pointer text-zinc-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={visibleSet.has(c.key)}
                  disabled={c.locked || saving}
                  onChange={() => toggle(c.key)}
                />
                {c.label}
                {c.locked && <span className="ml-auto text-[10px] text-zinc-400">always shown</span>}
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-2 text-[11px]">
            {error ? (
              <span className="text-red-600">{error}</span>
            ) : (
              <span className="text-zinc-400">{saving ? "Saving…" : "Saved for everyone"}</span>
            )}
            <button
              type="button"
              disabled={isStandard || saving}
              onClick={() => void save([...STANDARD_VISIBLE])}
              className="font-medium text-blue-700 hover:underline disabled:cursor-default disabled:text-zinc-300 disabled:no-underline"
            >
              Reset to standard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
