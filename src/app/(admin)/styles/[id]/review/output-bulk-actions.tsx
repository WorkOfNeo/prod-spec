"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RejectModal } from "./reject-modal";
import { IgnoreConfirmModal } from "./ignore-confirm-modal";
import { track, trackSettled, type AnalyticsEvent } from "@/lib/analytics";
import { buttonClass } from "@/components/ui/button";

// Per-output bulk shortcuts. Unlike the old job-level buttons, these act on
// the STYLE's current to-review outputs — which can span multiple generation
// jobs — by looping the per-output endpoints. An approve that completes a job
// still publishes that job (SharePoint + staged supplier email); staged
// emails surface on /settings/notifications. The per-output buttons on each
// card remain the primary interaction.
export function OutputBulkActions({
  styleId,
  styleContext,
  approveAssetIds,
  rejectAssetIds,
  ignoreAssetIds,
  blockedCount,
}: {
  styleId: string;
  styleContext: string;
  approveAssetIds: string[]; // pending and NOT placeholder-blocked
  rejectAssetIds: string[]; // all pending (blocked can still be rejected)
  ignoreAssetIds: string[]; // all pending minus bundle framing (cover / GI)
  blockedCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | "ignore" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // `event` is sent once per output that succeeded (analytics counts events).
  async function runAll(
    ids: string[],
    make: (id: string) => Promise<Response>,
    label: string,
    event: AnalyticsEvent,
  ) {
    let ok = 0;
    let failed = 0;
    // The decision that closed the job, if one did (the per-asset routes
    // answer `settled`) — for the review_completed analytics event.
    let settled: "APPROVED" | "REJECTED" | undefined;
    for (let i = 0; i < ids.length; i++) {
      setProgress(`${label} ${i + 1}/${ids.length}…`);
      try {
        const res = await make(ids[i]);
        if (res.ok) {
          ok += 1;
          track(event, { scope: "bulk" });
          const body = (await res.json().catch(() => ({}))) as { settled?: "APPROVED" | "REJECTED" };
          settled = body.settled ?? settled;
        } else failed += 1;
      } catch {
        failed += 1;
      }
    }
    trackSettled(settled);
    return { ok, failed };
  }

  async function approveAll() {
    setError(null);
    setPending("approve");
    try {
      const { ok, failed } = await runAll(
        approveAssetIds,
        (id) => fetch(`/api/admin/job-assets/${id}/approve`, { method: "POST" }),
        "Approving",
        "output_approved",
      );
      if (failed > 0) setError(`Approved ${ok}, ${failed} failed.`);
      router.refresh();
    } finally {
      setPending(null);
      setProgress(null);
    }
  }

  async function rejectAll(reason: string) {
    setError(null);
    setPending("reject");
    try {
      const { ok, failed } = await runAll(
        rejectAssetIds,
        (id) =>
          fetch(`/api/admin/job-assets/${id}/reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          }),
        "Rejecting",
        "output_rejected",
      );
      setRejecting(false);
      if (failed > 0) setError(`Rejected ${ok}, ${failed} failed.`);
      router.refresh();
    } finally {
      setPending(null);
      setProgress(null);
    }
  }

  // Ignore all — every pending output (blocked ones included: ignoring is
  // exactly how a placeholder-blocked output that shouldn't exist gets
  // resolved). Confirmed via the same dialog as the per-output button.
  async function ignoreAll() {
    setError(null);
    setPending("ignore");
    try {
      const { ok, failed } = await runAll(
        ignoreAssetIds,
        (id) => fetch(`/api/admin/job-assets/${id}/ignore`, { method: "POST" }),
        "Ignoring",
        "output_ignored",
      );
      setIgnoring(false);
      if (failed > 0) setError(`Ignored ${ok}, ${failed} failed.`);
      router.refresh();
    } finally {
      setPending(null);
      setProgress(null);
    }
  }

  const nothingToApprove = approveAssetIds.length === 0;
  const nothingToReject = rejectAssetIds.length === 0;
  if (nothingToApprove && nothingToReject) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setRejecting(true)}
          disabled={pending !== null || nothingToReject}
          className={buttonClass("ghost")}
        >
          {pending === "reject"
            ? "Rejecting…"
            : `Reject all${rejectAssetIds.length ? ` (${rejectAssetIds.length})` : ""}…`}
        </button>
        <button
          type="button"
          onClick={() => setIgnoring(true)}
          disabled={pending !== null || ignoreAssetIds.length === 0}
          title="Ignore every pending output for this style — skipped in generation, SharePoint and the nightly email"
          className={buttonClass("ghost")}
        >
          {pending === "ignore"
            ? "Ignoring…"
            : `Ignore all${ignoreAssetIds.length ? ` (${ignoreAssetIds.length})` : ""}…`}
        </button>
        <button
          type="button"
          onClick={approveAll}
          disabled={pending !== null || nothingToApprove}
          title="Approve every pending output that isn't blocked by a placeholder"
          className={buttonClass("secondary")}
        >
          {pending === "approve"
            ? "Approving…"
            : `Approve all${approveAssetIds.length ? ` (${approveAssetIds.length})` : ""}`}
        </button>
      </div>
      {blockedCount > 0 ? (
        <span className="text-warn text-[11px]">
          {blockedCount} output{blockedCount === 1 ? "" : "s"} blocked by placeholders — fix &amp; re-run.
        </span>
      ) : null}
      {progress ? <span className="text-muted text-[11px]">{progress}</span> : null}
      {error ? <span className="text-bad text-[12px]">{error}</span> : null}

      {rejecting ? (
        <RejectModal
          title="Reject all pending outputs"
          context={styleContext}
          pending={pending === "reject"}
          error={error}
          onCancel={() => setRejecting(false)}
          onConfirm={rejectAll}
        />
      ) : null}

      {ignoring ? (
        <IgnoreConfirmModal
          title="Ignore all pending outputs for this style?"
          context={styleContext}
          countNote={`${ignoreAssetIds.length} pending output${ignoreAssetIds.length === 1 ? "" : "s"} will be ignored.`}
          pending={pending === "ignore"}
          error={error}
          onCancel={() => setIgnoring(false)}
          onConfirm={ignoreAll}
        />
      ) : null}
    </div>
  );
}
