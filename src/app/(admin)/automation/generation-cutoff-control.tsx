"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Generation PO cutoff: "auto-generate ready outputs from this PO onward".
// Decoupled from the scrape cutoff. Accepts a pasted PO ("C-PO63144") or a bare
// number; empty clears it (falls back to the scrape cutoff). PATCHes the
// setting and refreshes.
export function GenerationCutoffControl({
  explicitCutoff,
  effectiveCutoff,
}: {
  // What's set explicitly for generation (null = following the scrape cutoff).
  explicitCutoff: number | null;
  // What the sweep actually uses right now (explicit, or the scrape fallback).
  effectiveCutoff: number | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(explicitCutoff === null ? "" : String(explicitCutoff));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/generation-min-po", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoff: value.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Failed to save (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Generate from PO</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            The generation sweep auto-generates ready outputs (even one at a time, each sent to
            review) for styles whose PO is <strong>at or above</strong> this number. Styles with no
            PO still generate. Paste a PO (e.g. <code>C-PO63144</code>) — everything from that PO
            onward is in scope. Empty ={" "}
            <em>follow the scrape cutoff{effectiveCutoff !== null ? ` (C-PO${effectiveCutoff})` : ""}</em>.
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {explicitCutoff !== null
              ? `Generating from C-PO${explicitCutoff} onward.`
              : effectiveCutoff !== null
                ? `Following the scrape cutoff — generating from C-PO${effectiveCutoff} onward.`
                : "No cutoff — generating the whole ready backlog."}
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
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
            onClick={save}
            disabled={saving}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
