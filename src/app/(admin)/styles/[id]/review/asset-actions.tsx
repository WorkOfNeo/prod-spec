"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";
import { RejectModal } from "./reject-modal";
import { IgnoreConfirmModal } from "./ignore-confirm-modal";
import { type PreparedImage } from "@/lib/images/downscale-image";

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
  canPush,
  canIgnore = true,
  customizeSlot,
}: {
  assetId: string;
  styleId: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectReason: string | null;
  placeholderCount: number;
  outputTitle: string;
  styleContext: string;
  // Admin-only: show the "Push to supplier" action for approved outputs.
  canPush: boolean;
  // False for bundle framing (cover / general info) — those regenerate with
  // every run and can't be ignored per style.
  canIgnore?: boolean;
  // Optional carton "Customize" trigger, rendered as a quiet utility action
  // in the footer's secondary row (the page passes <ReviewCartonCustomize/>
  // for carton-capable outputs).
  customizeSlot?: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | "ignore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushNote, setPushNote] = useState<{ text: string; url: string | null } | null>(null);

  const blocked = placeholderCount > 0;
  const blockedTitle = `${placeholderCount} placeholder(s) in this PDF (missing artwork / EAN) — fix the data and re-run before approving`;

  const isApproved = reviewStatus === "APPROVED";
  const isRejected = reviewStatus === "REJECTED";
  const isPending = reviewStatus === "PENDING_REVIEW";

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
        // until the email dialog is dismissed so the reviewer sees the
        // supplier email (staged — not auto-sent).
        setPublishNote("All outputs approved & published.");
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

  async function reject(comment: string, attachments: PreparedImage[]) {
    setError(null);
    setPending("reject");
    try {
      const res = await fetch(`/api/admin/job-assets/${assetId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: comment, attachments }),
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

  // Ignore — the third decision: this output isn't wanted for THIS style.
  // Confirmed via IgnoreConfirmModal (scope + consequences spelled out).
  // Ignoring the last open output settles the job like a decision would, so
  // the response mirrors approve's settle handling.
  async function ignore() {
    setError(null);
    setPending("ignore");
    try {
      const res = await fetch(`/api/admin/job-assets/${assetId}/ignore`, { method: "POST" });
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
      setIgnoring(false);
      if (body.publishError) {
        setError(`Ignored, but publish failed: ${body.publishError}`);
        router.refresh();
        return;
      }
      if (body.settled === "APPROVED") {
        // The remaining outputs were all approved → the job just published.
        setPublishNote("Output ignored — remaining outputs published.");
        if (body.email) {
          setEmail(body.email);
        } else {
          router.push(`/styles/${styleId}`);
          router.refresh();
        }
        return;
      }
      if (body.settled === "REJECTED") {
        router.push(`/styles/${styleId}`);
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  // Admin-only: push this approved output into the supplier's SharePoint
  // folder (creates the "<style> – <customer>" subfolder, uploads the PDF).
  async function push() {
    setError(null);
    setPushNote(null);
    setPushing(true);
    try {
      const res = await fetch(`/api/admin/job-assets/${assetId}/push-to-supplier`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        folderName?: string;
        targetFolderUrl?: string | null;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setPushNote({
        text: `Pushed to ${body.folderName ?? "supplier folder"}`,
        url: body.targetFolderUrl ?? null,
      });
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-100 px-3 py-2.5">
      {/* Secondary row — the decided status pill (left) and quiet utility
          actions (right): Customize for carton outputs, and a demoted Reject
          once an output is already approved. Only rendered when it has
          something to show, so a plain pending output skips straight to the
          decision row below. */}
      {isApproved || isRejected || customizeSlot ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            {isApproved ? (
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                ✓ Approved
              </span>
            ) : isRejected ? (
              <span
                className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700"
                title={rejectReason ?? undefined}
              >
                ✗ Rejected
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            {customizeSlot}
            {isApproved ? (
              <button
                type="button"
                onClick={() => setRejecting(true)}
                disabled={pending !== null}
                className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {pending === "reject" ? "Rejecting…" : "Reject"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Primary row — the main call to action for this output's state. A
          pending output gets the full Reject / Approve decision; an approved
          one gets Push to supplier; a rejected one keeps a way back in. */}
      {isPending ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={pending !== null}
            className="flex-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {pending === "reject" ? "Rejecting…" : "✗ Reject"}
          </button>
          {canIgnore ? (
            <button
              type="button"
              onClick={() => setIgnoring(true)}
              disabled={pending !== null}
              title="Not wanted for this style — skip it in generation, SharePoint and the nightly email"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              {pending === "ignore" ? "Ignoring…" : "⊘ Ignore"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={approve}
            disabled={pending !== null || blocked}
            title={blocked ? blockedTitle : "Approve this output"}
            className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "approve" ? "Approving…" : "✓ Approve"}
          </button>
        </div>
      ) : null}

      {isApproved && canPush ? (
        <button
          type="button"
          onClick={push}
          disabled={pushing}
          title="Create the supplier's SharePoint subfolder and upload this approved PDF"
          className="flex w-full items-center justify-center rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
        >
          {pushing ? "Pushing…" : "⬆ Push to supplier"}
        </button>
      ) : null}

      {isRejected ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={pending !== null || blocked}
            title={blocked ? blockedTitle : "Approve this output anyway"}
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "approve" ? "Approving…" : "✓ Approve anyway"}
          </button>
          {/* A rejected output that turns out to be "shouldn't exist for this
              style" resolves via Ignore — closes the ticket, stops re-runs. */}
          {canIgnore ? (
            <button
              type="button"
              onClick={() => setIgnoring(true)}
              disabled={pending !== null}
              title="Not wanted for this style — skip it in generation, SharePoint and the nightly email"
              className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
            >
              {pending === "ignore" ? "Ignoring…" : "⊘ Ignore"}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <span className="text-xs text-red-600">{error}</span> : null}
      {publishNote && !email ? (
        <span className="text-xs text-emerald-700">{publishNote}</span>
      ) : null}
      {pushNote ? (
        <span className="text-xs text-sky-700">
          {pushNote.text}
          {pushNote.url ? (
            <>
              {" · "}
              <a href={pushNote.url} target="_blank" rel="noopener noreferrer" className="underline">
                open folder
              </a>
            </>
          ) : null}
        </span>
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

      {ignoring ? (
        <IgnoreConfirmModal
          title={`Ignore “${outputTitle}” for this style?`}
          context={styleContext}
          pending={pending === "ignore"}
          error={error}
          onCancel={() => setIgnoring(false)}
          onConfirm={ignore}
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
