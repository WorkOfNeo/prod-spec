"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Done-group PO cutoff control. Paste a PO ("C-PO63144" or bare digits)
// and save: Done-group styles whose PO parses ABOVE it join the main list.
// Clear the field to hide all Done-group styles again (the default).
// Saving PATCHes the AppSetting and refreshes the server-rendered list.
export function DonePoCutoffSetting({ initialCutoff }: { initialCutoff: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initialCutoff !== null ? `C-PO${initialCutoff}` : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(initialCutoff);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/done-po-cutoff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoff: value }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; cutoff?: number | null };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      setApplied(j.cutoff ?? null);
      router.refresh(); // re-run the server query with the new cutoff
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900">Show Done-group styles above PO</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Done orders are normally hidden here. Paste a PO number to also show Done-group styles
            whose PO is <em>above</em> it — e.g. to review a backfill. Clear and save to hide them
            again.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="C-PO63144"
            className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="mt-2 text-xs text-zinc-400">
        {error ? (
          <span className="text-red-600">{error}</span>
        ) : applied !== null ? (
          <>Done-group styles with PO above C-PO{applied} are shown in the list below.</>
        ) : (
          <>All Done-group styles are hidden (default).</>
        )}
      </div>
    </div>
  );
}
