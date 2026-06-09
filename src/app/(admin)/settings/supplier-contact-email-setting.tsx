"use client";

import { useState } from "react";

// Admin-editable list of actual email address(es) CC'd on the supplier
// "ready for review" approval email. Comma-separated; persists to the
// AppSetting store via /api/admin/settings/supplier-contact-email.
export function SupplierContactEmailSetting({ initialEmails }: { initialEmails: string }) {
  const [emails, setEmails] = useState(initialEmails);
  const [saved, setSaved] = useState(initialEmails);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const dirty = emails.trim() !== saved.trim();

  async function save() {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/admin/settings/supplier-contact-email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; emails?: string };
      if (!res.ok) throw new Error(j.error ?? `Failed to save (${res.status})`);
      const next = j.emails ?? emails.trim();
      setSaved(next);
      setEmails(next);
      setOk(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-900">Supplier review CC email(s)</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Email address(es) CC&rsquo;d on every supplier &ldquo;ready for review&rdquo; approval email.
        Enter one or more, <strong>comma-separated</strong>. Leave blank for no CC. The supplier&rsquo;s
        own inbox (To) comes from the synced supplier record.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={emails}
          onChange={(e) => {
            setEmails(e.target.value);
            setOk(false);
          }}
          placeholder="jane@acme.com, ops@acme.com"
          className="w-96 max-w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
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
      {ok ? <p className="mt-2 text-xs text-emerald-600">Saved.</p> : null}
    </div>
  );
}
