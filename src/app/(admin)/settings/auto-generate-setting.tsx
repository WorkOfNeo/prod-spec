"use client";

import { useState } from "react";
import { Toggle } from "@/components/toggle";

// Global "auto-generate outputs" master switch. Optimistic toggle that
// PATCHes /api/admin/settings/auto-generate and reverts on failure.
export function AutoGenerateSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    setEnabled(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/auto-generate", {
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
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Auto-generate outputs</h2>
          <p className="mt-1 text-sm text-zinc-500">
            When on, a style that reaches its ProdSpec&rsquo;s completion threshold automatically
            generates the PDF outputs configured for its Customer × Business Area. When off, styles
            still sync from Monday, but no PDFs are produced until someone runs them manually.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <Toggle
          checked={enabled}
          onChange={update}
          disabled={saving}
          size="md"
          ariaLabel="Auto-generate outputs"
        />
      </div>
      <div className="mt-3 text-xs text-zinc-400">
        {saving
          ? "Saving…"
          : enabled
            ? "Automatic generation is ON."
            : "Automatic generation is OFF — manual generation only."}
      </div>
    </div>
  );
}
