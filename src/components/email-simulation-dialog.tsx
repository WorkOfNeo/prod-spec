"use client";

import { useEffect, useState } from "react";

// What the dialog renders. Matches the EmailOutcome JSON the API routes
// return (src/lib/email/dispatch.ts); the activity table passes a slim
// variant without htmlPreview and the body is fetched on open instead.
export type EmailOutcomeView = {
  status: "SENT" | "SIMULATED" | "SKIPPED" | "FAILED";
  type: string;
  to: string;
  cc?: string | null;
  from?: string | null;
  subject: string;
  attachments?: Array<{ filename: string; bytes: number }>;
  htmlPreview?: string | null;
  note?: string | null;
  emailLogId?: string | null;
  createdAtLabel?: string | null;
};

const HEADINGS: Record<EmailOutcomeView["status"], { title: string; tone: string }> = {
  SENT: { title: "📧 Email sent", tone: "text-emerald-700" },
  SIMULATED: { title: "📧 Email simulation — nothing was sent", tone: "text-amber-700" },
  SKIPPED: { title: "📧 Email skipped", tone: "text-zinc-700" },
  FAILED: { title: "📧 Email failed", tone: "text-red-700" },
};

const TYPE_LABELS: Record<string, string> = {
  REVIEW_READY: "Review notification (internal)",
  TICKET_FIXED: "Fixed — ready for re-review (internal)",
  SUPPLIER_APPROVAL: "Supplier approval",
  INVITE: "Signup invitation",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Modal showing exactly what an email contained (or would have, while
// RESEND_EMAILS is off): recipients, subject, attachment list and the full
// body in a sandboxed iframe. Shared by the review screen, the per-output
// Run buttons, the rejection log and the /settings/notifications activity
// table.
export function EmailSimulationDialog({
  outcome,
  onClose,
}: {
  outcome: EmailOutcomeView;
  onClose: () => void;
}) {
  const [html, setHtml] = useState<string | null>(outcome.htmlPreview ?? null);
  const [bodyError, setBodyError] = useState<string | null>(null);

  // "Send for real" override form (one-off send while RESEND_EMAILS is off).
  const [sendTo, setSendTo] = useState(outcome.to);
  const [sendFrom, setSendFrom] = useState(outcome.from ?? "");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Slim payloads (activity table rows) carry only the log id — pull the
  // body on open so the list view never ships 50 HTML documents.
  useEffect(() => {
    if (html !== null || !outcome.emailLogId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/email-logs/${outcome.emailLogId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { html?: string; defaultFrom?: string };
        if (!cancelled) {
          setHtml(body.html ?? "");
          if (body.defaultFrom) setSendFrom((f) => f || body.defaultFrom!);
        }
      } catch (e) {
        if (!cancelled) setBodyError(e instanceof Error ? e.message : "Failed to load body");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html, outcome.emailLogId]);

  async function sendForReal() {
    if (!outcome.emailLogId) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`/api/admin/email-logs/${outcome.emailLogId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: sendTo, from: sendFrom || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; email?: { status: string; to: string; note?: string | null } }
        | null;
      if (!res.ok) {
        setSendResult({ ok: false, message: data?.error ?? `HTTP ${res.status}` });
      } else if (data?.email?.status === "SENT") {
        setSendResult({ ok: true, message: `Sent to ${data.email.to} — check the inbox.` });
      } else {
        setSendResult({
          ok: false,
          message: data?.email?.note ?? `Not sent (${data?.email?.status ?? "unknown"}).`,
        });
      }
    } catch (e) {
      setSendResult({ ok: false, message: e instanceof Error ? e.message : "Send failed" });
    } finally {
      setSending(false);
    }
  }

  const heading = HEADINGS[outcome.status];
  const attachments = outcome.attachments ?? [];
  // Manual one-off send: anything that didn't actually go out can be pushed
  // through Resend with an overridden To/From — except emails that carried
  // attachments (bytes aren't stored, a partial re-send would mislead).
  const canSendForReal =
    Boolean(outcome.emailLogId) && outcome.status !== "SENT" && attachments.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-100 px-5 py-4">
          <div className={`text-sm font-semibold ${heading.tone}`}>{heading.title}</div>
          {outcome.note ? <p className="mt-1 text-xs text-zinc-500">{outcome.note}</p> : null}
        </div>

        <div className="space-y-1 px-5 py-3 text-xs">
          <Row label="Type" value={TYPE_LABELS[outcome.type] ?? outcome.type} />
          {outcome.createdAtLabel ? <Row label="When" value={outcome.createdAtLabel} /> : null}
          <Row label="To" value={outcome.to || "— no recipient resolved"} faded={!outcome.to} />
          {outcome.cc ? <Row label="CC" value={outcome.cc} /> : null}
          <Row label="Subject" value={outcome.subject} />
          {attachments.length > 0 ? (
            <Row
              label="Attachments"
              value={`${attachments.length} file${attachments.length === 1 ? "" : "s"} · ${attachments
                .map((a) => `${a.filename} (${formatBytes(a.bytes)})`)
                .join(", ")}`}
            />
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden border-t border-zinc-100 bg-zinc-50 px-5 py-3">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">Body</div>
          {bodyError ? (
            <p className="text-xs text-red-600">Could not load the body: {bodyError}</p>
          ) : html === null ? (
            <p className="text-xs text-zinc-400">Loading…</p>
          ) : (
            <iframe
              sandbox=""
              srcDoc={html}
              title="Email body preview"
              className="h-64 w-full rounded-md border border-zinc-200 bg-white"
            />
          )}
        </div>

        {canSendForReal && (
          <div className="border-t border-zinc-100 px-5 py-3">
            <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
              Send for real — one-off, the flag stays off
            </div>
            <p className="mb-2 text-[11px] text-zinc-500">
              Would have gone to <span className="font-medium text-zinc-700">{outcome.to || "—"}</span>.
              Override the recipient (e.g. your own inbox) to test the full delivery path.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={sendTo}
                disabled={sending}
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="recipient@…"
                className="min-w-44 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
              />
              <input
                type="text"
                value={sendFrom}
                disabled={sending}
                onChange={(e) => setSendFrom(e.target.value)}
                placeholder="From (default sender)"
                title="Sender — must be on a Resend-verified domain"
                className="min-w-44 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
              />
              <button
                type="button"
                disabled={sending || !sendTo}
                onClick={sendForReal}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send now"}
              </button>
            </div>
            {sendResult && (
              <p className={`mt-2 text-xs ${sendResult.ok ? "text-emerald-700" : "text-red-600"}`}>
                {sendResult.ok ? "✓ " : "✗ "}
                {sendResult.message}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, faded }: { label: string; value: string; faded?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-zinc-400">{label}</span>
      <span className={`min-w-0 break-words ${faded ? "text-amber-700" : "text-zinc-700"}`}>{value}</span>
    </div>
  );
}
