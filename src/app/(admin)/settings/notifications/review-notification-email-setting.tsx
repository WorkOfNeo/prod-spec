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
    <div className="rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink">Review notification email(s)</h2>
      <p className="mt-1 text-sm text-muted">
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
          className="w-96 max-w-full rounded-md border border-line px-3 py-2 text-sm focus:ring-2 focus:ring-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-bad">{error}</p> : null}
      {ok ? <p className="mt-2 text-xs text-good">Saved.</p> : null}
      <p className="mt-2 text-xs text-muted">
        {effective ? (
          <>
            Currently resolving to: <strong>{effective}</strong>{" "}
            {saved.trim() ? "(this setting)" : "(REVIEW_NOTIFICATION_EMAIL env fallback)"}
          </>
        ) : (
          <span className="text-warn">
            No recipient configured — notifications are recorded as SKIPPED until one is set here (or
            via the REVIEW_NOTIFICATION_EMAIL env var).
          </span>
        )}
        {resolvedEmails !== effective && resolvedEmails ? <> · resolved at load: {resolvedEmails}</> : null}
      </p>
    </div>
  );
}
