"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";
import { RejectModal } from "./reject-modal";

// Per-output decision UI on the review screen. Approve / Reject hit the
// per-asset endpoints; approving the LAST pending output makes the server
// roll the job up and publish (SharePoint + supplier email) — the response
// then carries the email outcome, surfaced here as a dialog before we
// navigate back to the style.
export function AssetActions({
  assetId,
  styleId,
  reviewStatus,
  rejectReason,
  placeholderCount,
  outputTitle,
  styleContext,
}: {
  assetId: string;
  styleId: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectReason: string | null;
  placeholderCount: number;
  outputTitle: string;
  styleContext: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);

  const blocked = placeholderCount > 0;

  async function approve() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/admin/job-assets/${assetId}/approve`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        settled?: "APPROVED" | "REJECTED";
        email?: EmailOutcomeView | null;
        publishError?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      if (body.publishError) {
        setError(`Approved, but publish failed: ${body.publishError}`);
        router.refresh();
        return;
      }
      if (body.settled === "APPROVED") {
        // All outputs approved → the job just published. Hold navigation
        // until the email dialog is dismissed so the reviewer sees what
        // went to the supplier (or would have, in simulation mode).
        setPublishNote("All outputs approved — published to the supplier.");
        if (body.email) {
          setEmail(body.email);
        } else {
          router.push(`/styles/${styleId}`);
          router.refresh();
        }
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function reject(comment: string) {
    setError(null);
    setPending("reject");
    try {
      const res = await fetch(`/api/admin/job-assets/${assetId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: comment }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        settled?: "REJECTED";
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setRejecting(false);
      if (body.settled === "REJECTED") {
        // Last open output rejected — the job settled. Same exit as the
        // job-level reject: back to the style page.
        router.push(`/styles/${styleId}`);
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {reviewStatus === "APPROVED" ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
            ✓ APPROVED
          </span>
        ) : reviewStatus === "REJECTED" ? (
          <span
            className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700"
            title={rejectReason ?? undefined}
          >
            ✗ REJECTED
          </span>
        ) : null}

        {reviewStatus !== "APPROVED" ? (
          <button
            type="button"
            onClick={approve}
            disabled={pending !== null || blocked}
            title={
              blocked
                ? `${placeholderCount} placeholder(s) in this PDF (missing artwork / EAN) — fix the data and re-run before approving`
                : "Approve this output"
            }
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "approve" ? "Approving…" : "✓ Approve"}
          </button>
        ) : null}
        {reviewStatus !== "REJECTED" ? (
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={pending !== null}
            className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {pending === "reject" ? "Rejecting…" : "✗ Reject…"}
          </button>
        ) : null}
      </div>
      {error ? <span className="max-w-64 text-right text-xs text-red-600">{error}</span> : null}
      {publishNote && !email ? (
        <span className="text-right text-xs text-emerald-700">{publishNote}</span>
      ) : null}

      {rejecting ? (
        <RejectModal
          title={`Reject “${outputTitle}”`}
          context={styleContext}
          pending={pending === "reject"}
          error={error}
          onCancel={() => setRejecting(false)}
          onConfirm={reject}
        />
      ) : null}

      {email ? (
        <EmailSimulationDialog
          outcome={email}
          onClose={() => {
            setEmail(null);
            router.push(`/styles/${styleId}`);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
