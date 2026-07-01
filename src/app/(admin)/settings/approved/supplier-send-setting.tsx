"use client";

import { useState } from "react";
import { Toggle } from "@/components/toggle";

// Master switch for the nightly supplier-send system. Optimistic toggle that
// PATCHes /api/admin/settings/supplier-batch-send and reverts on failure.
// OFF by default: the queue still fills + shows below, but nothing pushes or
// sends until this is on.
export function SupplierSendSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/supplier-batch-send", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Failed to save (${res.status})`);
      }
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`rounded-lg border p-5 ${
        enabled ? "border-emerald-300 bg-emerald-50/40" : "border-amber-300 bg-amber-50/40"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Automatic supplier sending</h2>
          <p className="mt-1 text-sm text-zinc-600">
            When <strong>on</strong>, approved outputs are pushed to the supplier&rsquo;s SharePoint
            folder as soon as they&rsquo;re approved, and the midnight job emails each supplier one
            digest of everything waiting for them. When <strong>off</strong> (the default), the
            queue below still fills so you can see exactly what would be sent &mdash; but{" "}
            <strong>nothing is pushed and no email is sent</strong>.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <Toggle
          checked={enabled}
          onChange={update}
          disabled={saving}
          size="md"
          ariaLabel="Automatic supplier sending"
        />
      </div>
      <div className="mt-3 text-xs text-zinc-500">
        {saving
          ? "Saving…"
          : enabled
            ? "Sending is ON — approved outputs push to SharePoint and suppliers are emailed at midnight."
            : "Sending is OFF — capture + preview only. Nothing leaves the building."}
      </div>
    </div>
  );
}
