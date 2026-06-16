"use client";

import { useState } from "react";
import { Toggle } from "@/components/toggle";

// Master switch for OUTBOUND Monday status write-backs. Optimistic toggle
// that PATCHes /api/admin/settings/monday-writeback and reverts on failure.
// Default OFF — until an admin turns it on, the app only LOGS what it would
// write (see the write-back log below this card).
export function MondayWriteBackSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(next: boolean) {
    setEnabled(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/monday-writeback", {
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
          <h2 className="text-sm font-semibold text-zinc-900">Status write-backs to Monday</h2>
          <p className="mt-1 text-sm text-zinc-500">
            When on, ProdSpec writes statuses back to Monday: a fully-approved style flips the Styles
            board subitems <strong>01e</strong> + <strong>01f</strong> to <strong>Approved</strong>.
            Rejections never write back to Monday. When off,
            <strong> nothing is sent to Monday</strong> — every write that would have happened is
            still recorded below so you can preview it first. Emails and inbound webhooks are
            unaffected by this switch.
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
        <Toggle
          checked={enabled}
          onChange={update}
          disabled={saving}
          size="md"
          ariaLabel="Status write-backs to Monday"
        />
      </div>
      <div className="mt-3 text-xs text-zinc-400">
        {saving
          ? "Saving…"
          : enabled
            ? "Write-backs are ON — statuses are sent to Monday."
            : "Write-backs are OFF — simulated only (logged below, nothing sent to Monday)."}
      </div>
    </div>
  );
}
