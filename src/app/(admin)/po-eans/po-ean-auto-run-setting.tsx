"use client";

import { useState } from "react";
import { Toggle } from "@/components/toggle";

// Automatic PO→EAN scrape switch. Optimistic toggle that PATCHes
// /api/admin/settings/po-ean-auto-run and reverts on failure — same
// pattern as the auto-generate master switch on /settings.
export function PoEanAutoRunSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    setEnabled(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/po-ean-auto-run", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Failed to save (${res.status})`);
      }
    } catch (e) {
      setEnabled(!next); // revert
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Automatic barcode scraping</h2>
          <p className="mt-1 text-sm text-zinc-500">
            When on, the cron drains this queue automatically — every PENDING style gets its PO PDF
            scraped from SharePoint. When off, styles still queue here as their PO numbers land, but
            nothing is scraped until you click &ldquo;Re-resolve&rdquo; (per row, or the batch
            button) — manual clicks always work.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <Toggle
          checked={enabled}
          onChange={update}
          disabled={saving}
          size="md"
          ariaLabel="Automatic barcode scraping"
        />
      </div>
      <div className="mt-2 text-xs text-zinc-400">
        {saving
          ? "Saving…"
          : enabled
            ? "Auto-scrape is ON — the queue drains itself."
            : "Auto-scrape is OFF — the queue only drains when you click."}
      </div>
    </div>
  );
}
