"use client";

import { useState } from "react";

// Admin-editable internal recipient(s) for the post-generation emails:
// "ready for review" (job generated) and "fixed — ready for re-review"
// (rejection ticket marked fixed). Comma-separated; persists to the
// AppSetting store via /api/admin/settings/review-notification-email.
export function ReviewNotificationEmailSetting({
  initialEmails,
  resolvedEmails,
  envFallback,
}: {
  initialEmails: string;
  resolvedEmails: string;
  envFallback: string;
}) {
  const [emails, setEmails] = useState(initialEmails);
  const [saved, setSaved] = useState(initialEmails);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const dirty = emails.trim() !== saved.trim();
  // What the runner will actually use right now. Mirrors the accessor's
  // fallback chain (setting → env) so the operator never has to guess.
  const effective = saved.trim() || envFallback;

  async function save() {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/admin/settings/review-notification-email", {
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
      <h2 className="text-sm font-semibold text-zinc-900">Review notification email(s)</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Internal recipient(s) notified whenever outputs are generated, and again when a rejected
        output is marked fixed. Enter one or more, <strong>comma-separated</strong>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={emails}
          onChange={(e) => {
            setEmails(e.target.value);
            setOk(false);
          }}
          placeholder="review@yourcompany.com"
          className="w-96 max-w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
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
      <p className="mt-2 text-xs text-zinc-500">
        {effective ? (
          <>
            Currently resolving to: <strong>{effective}</strong>{" "}
            {saved.trim() ? "(this setting)" : "(REVIEW_NOTIFICATION_EMAIL env fallback)"}
          </>
        ) : (
          <span className="text-amber-700">
            No recipient configured — notifications are recorded as SKIPPED until one is set here (or
            via the REVIEW_NOTIFICATION_EMAIL env var).
          </span>
        )}
        {resolvedEmails !== effective && resolvedEmails ? <> · resolved at load: {resolvedEmails}</> : null}
      </p>
    </div>
  );
}
