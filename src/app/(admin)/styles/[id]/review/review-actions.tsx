"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";
import { RejectModal } from "./reject-modal";

// Job-level bulk actions. The per-output buttons on each card are the
// primary review interaction (see asset-actions.tsx); these two remain as
// shortcuts: approve-everything-and-publish / reject-everything.
export function ReviewActions({
  jobId,
  styleId,
  styleContext,
  sharepointConfigured,
}: {
  jobId: string;
  styleId: string;
  styleContext: string;
  sharepointConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  // Set after a successful approve — the supplier-email recipients summary
  // returned by the route. Kept on screen (we don't auto-navigate) so the
  // To/CC can be confirmed, especially while email sending is off.
  const [result, setResult] = useState<EmailNotification | null>(null);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);
  const [showEmail, setShowEmail] = useState(false);

  async function approve() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/approve`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        notification?: EmailNotification;
        email?: EmailOutcomeView | null;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(body.notification ?? { to: null, cc: null, attachments: 0, folderUrl: null, sent: false });
      setEmail(body.email ?? null);
      // Simulation mode: pop the full email straight away — that's the
      // whole point of the flag being off.
      if (body.email && body.email.status !== "SENT") setShowEmail(true);
    } finally {
      setPending(null);
    }
  }

  async function reject(comment: string) {
    setError(null);
    setPending("reject");
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: comment }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/styles/${styleId}`);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  if (result) {
    return (
      <>
        <ApprovedPanel result={result} styleId={styleId} onViewEmail={email ? () => setShowEmail(true) : null} />
        {showEmail && email ? (
          <EmailSimulationDialog outcome={email} onClose={() => setShowEmail(false)} />
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setRejecting(true)}
          disabled={pending !== null}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
        >
          {pending === "reject" ? "Rejecting…" : "Reject all…"}
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={pending !== null}
          title={
            sharepointConfigured
              ? "Approve every pending output, upload to SharePoint and email the supplier"
              : "SharePoint not configured — publishes with email attachments only"
          }
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending === "approve" ? "Approving…" : "Approve all & publish"}
        </button>
      </div>
      {!sharepointConfigured ? (
        <span className="text-[11px] text-zinc-400">
          SharePoint not configured — supplier gets the PDFs as attachments only.
        </span>
      ) : null}
      {error && <span className="text-xs text-red-600">{error}</span>}

      {rejecting ? (
        <RejectModal
          title="Reject all pending outputs"
          context={styleContext}
          pending={pending === "reject"}
          error={error}
          onCancel={() => setRejecting(false)}
          onConfirm={reject}
        />
      ) : null}
    </div>
  );
}

type EmailNotification = {
  to: string | null;
  cc: string | null;
  attachments: number;
  folderUrl: string | null;
  sent: boolean;
  note?: string;
};

// Shown after a successful approve. Confirms the supplier-email recipients
// (To / CC) and whether it was actually sent or simulated (RESEND_EMAILS
// off). Persisted copy also lands in the job log on the style page.
function ApprovedPanel({
  result,
  styleId,
  onViewEmail,
}: {
  result: EmailNotification;
  styleId: string;
  onViewEmail: (() => void) | null;
}) {
  return (
    <div className="w-full max-w-md rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
      <div className="font-semibold text-emerald-800">✓ Approved &amp; published</div>
      <div className="mt-2 text-zinc-700">
        {result.sent ? "Supplier email sent:" : "Supplier email — simulated (sending is off):"}
      </div>
      <ul className="mt-1 space-y-0.5 text-xs text-zinc-700">
        <li>
          <span className="text-zinc-500">To:</span>{" "}
          {result.to ?? <span className="text-amber-700">— no recipient resolved</span>}
        </li>
        <li>
          <span className="text-zinc-500">CC:</span> {result.cc ?? "—"}
        </li>
        <li>
          <span className="text-zinc-500">Attachments:</span> {result.attachments} PDF
          {result.attachments === 1 ? "" : "s"}
        </li>
        {result.folderUrl && (
          <li>
            <span className="text-zinc-500">SharePoint folder:</span>{" "}
            <a
              href={result.folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-700 underline"
            >
              open
            </a>
          </li>
        )}
      </ul>
      {result.note && <p className="mt-2 text-xs text-zinc-500">{result.note}</p>}
      <div className="mt-3 flex items-center gap-2">
        <a
          href={`/styles/${styleId}`}
          className="inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          Back to style
        </a>
        {onViewEmail ? (
          <button
            type="button"
            onClick={onViewEmail}
            className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
          >
            View email
          </button>
        ) : null}
      </div>
    </div>
  );
}
