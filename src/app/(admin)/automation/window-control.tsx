"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Recent-window control: how many days back auto-scrape + the generation sweep
// reach. 0 disables the window (whole backlog). PATCHes the setting and refreshes.
export function WindowControl({
  initialDays,
  parkedCount,
}: {
  initialDays: number;
  parkedCount: number;
}) {
  const router = useRouter();
  const [days, setDays] = useState(String(initialDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0) {
      setError("Enter a whole number of days (0 or more)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/automation-window", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: Math.floor(n) }),
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
          <h2 className="text-sm font-semibold text-zinc-900">Recent-window</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Auto-scrape and the generation sweep only touch styles whose PO landed within this many
            days. Older POs are parked
            {parkedCount > 0 ? ` (${parkedCount.toLocaleString()} right now)` : ""} — never
            auto-processed, but still scrape-able per-row from <strong>/po-eans</strong>. Set{" "}
            <strong>0</strong> to disable the window and process the whole backlog.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <span className="text-sm text-zinc-500">days</span>
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
