"use client";

import { useState } from "react";

// Admin-editable Monday column ID for the supplier's contact-person email
// (the CC on the approval email). Persists to the AppSetting store via
// /api/admin/settings/supplier-contact-email; takes effect on the next
// supplier sync.
export function SupplierContactEmailSetting({ initialColumnId }: { initialColumnId: string }) {
  const [columnId, setColumnId] = useState(initialColumnId);
  const [saved, setSaved] = useState(initialColumnId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const dirty = columnId.trim() !== saved.trim();

  async function save() {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/admin/settings/supplier-contact-email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columnId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; columnId?: string };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      const next = j.columnId ?? columnId.trim();
      setSaved(next);
      setColumnId(next);
      setOk(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-900">Supplier contact email column</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Monday Suppliers-board column ID for the supplier&rsquo;s contact-person email. This becomes
        the <strong>CC</strong> on the &ldquo;ready for review&rdquo; approval email. Leave blank for
        no CC. Takes effect on the next supplier sync.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={columnId}
          onChange={(e) => {
            setColumnId(e.target.value);
            setOk(false);
          }}
          placeholder="e.g. email_2"
          className="w-64 rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      {ok ? <p className="mt-2 text-xs text-emerald-600">Saved. Re-sync suppliers to apply.</p> : null}
      <p className="mt-2 text-xs text-zinc-400">
        The supplier&rsquo;s main inbox (To) stays on the{" "}
        <code className="font-mono">MONDAY_SUPPLIER_COL_EMAIL</code> env var.
      </p>
    </div>
  );
}
