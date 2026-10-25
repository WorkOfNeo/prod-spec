"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, CornerUpLeft, Upload } from "lucide-react";
import { EmailSimulationDialog, type EmailOutcomeView } from "@/components/email-simulation-dialog";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { track, trackSettled } from "@/lib/analytics";
import { timeAgo } from "@/lib/time";
import { IgnoreConfirmModal } from "./ignore-confirm-modal";
import { CommentImagesTray, useCommentImages } from "./comment-images";
import type { ProofItem } from "./review-types";

// The decision for one output, comment first: say what needs to change and
// it goes to the rejection log as a request for changes; say nothing and
// approve. Approve / reject / ignore / push hit the same per-asset endpoints
// the old card buttons did. Approving the LAST pending output makes the server
// roll the job up and publish (SharePoint + supplier email) — the response then
// carries the email outcome, shown as a dialog before we go back to the style.
//
// A decision that doesn't settle the job calls onDecided, which moves the
// workspace on to the next output still waiting.
export function DecisionPanel({
  item,
  styleId,
  styleContext,
  canPush,
  onDecided,
}: {
  item: ProofItem;
  styleId: string;
  styleContext: string;
  // Admin-only: "Push to supplier" for an approved output.
  canPush: boolean;
  onDecided: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | "ignore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const [email, setEmail] = useState<EmailOutcomeView | null>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushNote, setPushNote] = useState<{ text: string; url: string | null } | null>(null);
  const [comment, setComment] = useState("");
  const images = useCommentImages();

  const isApproved = item.status === "APPROVED";
  const isRejected = item.status === "REJECTED";
  const isPending = item.status === "PENDING_REVIEW";
  // An approved output keeps its comment box folded until asked for.
  const [composing, setComposing] = useState(!isApproved);

  const blocked = item.placeholderCount > 0;
  const trimmed = comment.trim();
  const busy = pending !== null || images.preparing > 0;
  const fixed = item.thread?.status === "FIXED";

  async function approve() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/admin/job-assets/${item.assetId}/approve`, { method: "POST" });
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
      track("output_approved", { scope: "single" });
      trackSettled(body.settled);
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
      onDecided();
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function requestChanges() {
    if (!trimmed) return;
    setError(null);
    setPending("reject");
    try {
      const res = await fetch(`/api/admin/job-assets/${item.assetId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed, attachments: images.images }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; settled?: "REJECTED" };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      track("output_rejected", { scope: "single", images: images.images.length });
      trackSettled(body.settled);
      setComment("");
      images.reset();
      if (body.settled === "REJECTED") {
        // Last open output rejected — the job settled. Same exit as the
        // job-level reject: back to the style page.
        router.push(`/styles/${styleId}`);
        router.refresh();
        return;
      }
      onDecided();
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  // Ignore — the third decision: this output isn't wanted for THIS style.
  // Ignoring the last open output settles the job like a decision would, so
  // the response mirrors approve's settle handling.
  async function ignore() {
    setError(null);
    setPending("ignore");
    try {
      const res = await fetch(`/api/admin/job-assets/${item.assetId}/ignore`, { method: "POST" });
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
      track("output_ignored", { scope: "single" });
      trackSettled(body.settled);
      setIgnoring(false);
      if (body.publishError) {
        setError(`Ignored, but publish failed: ${body.publishError}`);
        router.refresh();
        return;
      }
      if (body.settled === "APPROVED") {
        // The remaining outputs were all approved → the job just published.
        setPublishNote("Output ignored, remaining outputs published.");
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
        router.refresh();
        return;
      }
      onDecided();
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  // Admin-only: push this approved output into the supplier's SharePoint
  // folder (creates/reuses the "<PO> - <customer> - <supplier>" folder →
  // "APPROVED LAYOUTS" subfolder, uploads the PDF).
  async function push() {
    setError(null);
    setPushNote(null);
    setPushing(true);
    try {
      const res = await fetch(`/api/admin/job-assets/${item.assetId}/push-to-supplier`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        folderName?: string;
        targetFolderUrl?: string | null;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      track("supplier_files_pushed", { scope: "output" });
      setPushNote({ text: `Pushed to ${body.folderName ?? "supplier folder"}`, url: body.targetFolderUrl ?? null });
    } finally {
      setPushing(false);
    }
  }

  return (
    <div data-section="Decision" className="flex flex-col gap-3">
      {isApproved ? (
        <div className="flex items-center justify-between gap-2">
          <Pill tone="good" dot>
            Approved
            {item.reviewedAtIso ? (
              <span suppressHydrationWarning className="opacity-80">
                · {timeAgo(new Date(item.reviewedAtIso))}
              </span>
            ) : null}
          </Pill>
          {!composing ? (
            <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>
              <CornerUpLeft size={13} aria-hidden="true" />
              Reopen with a comment
            </Button>
          ) : null}
        </div>
      ) : null}

      {composing ? (
        <div
          className={`border-line bg-surface focus-within:border-accent rounded-lg border transition-colors ${
            images.dragOver ? "border-accent ring-accent/30 ring-2" : ""
          }`}
          {...images.dropTarget(busy)}
        >
          <label htmlFor={`comment-${item.key}`} className="sr-only">
            Comment
          </label>
          <textarea
            id={`comment-${item.key}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && trimmed && !busy) void requestChanges();
            }}
            placeholder={
              isRejected ? "Anything else that needs to change?" : "What needs to change? Leave it empty to approve."
            }
            rows={4}
            className="text-ink placeholder:text-faint block w-full resize-y rounded-t-lg bg-transparent px-3 py-2.5 text-[13px] leading-relaxed outline-none"
          />
          <div className="border-line flex items-center justify-between gap-2 border-t px-1.5 py-1">
            <CommentImagesTray state={images} disabled={busy} />
          </div>
        </div>
      ) : null}

      {/* The decision. Pending: request changes or approve. Rejected: add to
          the comments, or approve after all. Approved: reopen (above). */}
      <div className="flex flex-wrap gap-2">
        {composing ? (
          <Button
            variant="danger"
            onClick={requestChanges}
            disabled={busy || trimmed.length === 0}
            title="Send the comment to the rejection log and mark this output as needing changes"
            className="flex-1"
          >
            {pending === "reject" ? "Sending…" : isRejected ? "Add comment" : "Request changes"}
          </Button>
        ) : null}
        {isPending || isRejected ? (
          <Button
            variant={isPending || fixed ? "primary" : "secondary"}
            onClick={approve}
            disabled={busy || blocked || trimmed.length > 0}
            title={
              blocked
                ? `${item.placeholderCount} placeholder(s) in this PDF (missing artwork / EAN): fix the data and re-run before approving`
                : trimmed.length > 0
                  ? "You have an unsent comment"
                  : "Approve this output"
            }
            className="flex-1"
          >
            <Check size={14} aria-hidden="true" />
            {pending === "approve" ? "Approving…" : isRejected && !fixed ? "Approve anyway" : "Approve"}
          </Button>
        ) : null}
        {isApproved && composing ? (
          <Button variant="ghost" onClick={() => setComposing(false)} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>

      {blocked && !isApproved ? (
        <p className="text-warn text-[12px] leading-relaxed">
          {item.placeholderCount} placeholder{item.placeholderCount === 1 ? "" : "s"} in this PDF, so it can&rsquo;t be
          approved until the data is fixed and the output re-run.
        </p>
      ) : trimmed.length > 0 && !isApproved ? (
        <p className="text-muted text-[12px]">
          Send your comment with {isRejected ? "Add comment" : "Request changes"}, or clear it to approve.
          <span className="text-faint"> ⌘↵ sends.</span>
        </p>
      ) : null}

      {isApproved && canPush ? (
        <Button
          onClick={push}
          disabled={pushing}
          title="Create the supplier's SharePoint subfolder and upload this approved PDF"
        >
          <Upload size={14} aria-hidden="true" />
          {pushing ? "Pushing…" : "Push to supplier"}
        </Button>
      ) : null}

      {item.canIgnore && !isApproved ? (
        <button
          type="button"
          onClick={() => setIgnoring(true)}
          disabled={busy}
          title="Not wanted for this style: skip it in generation, SharePoint and the nightly email"
          className="text-muted hover:text-ink self-start text-[12px] underline-offset-2 hover:underline disabled:opacity-50"
        >
          {pending === "ignore" ? "Ignoring…" : "Not needed for this style? Ignore it"}
        </button>
      ) : null}

      {error ? <p className="text-bad text-[12px]">{error}</p> : null}
      {publishNote && !email ? <p className="text-good text-[12px]">{publishNote}</p> : null}
      {pushNote ? (
        <p className="text-ink text-[12px]">
          {pushNote.text}
          {pushNote.url ? (
            <>
              {" · "}
              <a href={pushNote.url} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
                open folder
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {ignoring ? (
        <IgnoreConfirmModal
          title={`Ignore “${item.name}” for this style?`}
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
