"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RejectModal } from "./reject-modal";
import { IgnoreConfirmModal } from "./ignore-confirm-modal";

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
  blockedCount,
}: {
  styleId: string;
  styleContext: string;
  approveAssetIds: string[]; // pending and NOT placeholder-blocked
  rejectAssetIds: string[]; // all pending (blocked can still be rejected)
  blockedCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | "ignore" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function runAll(ids: string[], make: (id: string) => Promise<Response>, label: string) {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      setProgress(`${label} ${i + 1}/${ids.length}…`);
      try {
        const res = await make(ids[i]);
        if (res.ok) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
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
        rejectAssetIds,
        (id) => fetch(`/api/admin/job-assets/${id}/ignore`, { method: "POST" }),
        "Ignoring",
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
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
        >
          {pending === "reject"
            ? "Rejecting…"
            : `Reject all${rejectAssetIds.length ? ` (${rejectAssetIds.length})` : ""}…`}
        </button>
        <button
          type="button"
          onClick={() => setIgnoring(true)}
          disabled={pending !== null || nothingToReject}
          title="Ignore every pending output for this style — skipped in generation, SharePoint and the nightly email"
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
        >
          {pending === "ignore"
            ? "Ignoring…"
            : `Ignore all${rejectAssetIds.length ? ` (${rejectAssetIds.length})` : ""}…`}
        </button>
        <button
          type="button"
          onClick={approveAll}
          disabled={pending !== null || nothingToApprove}
          title="Approve every pending output that isn't blocked by a placeholder"
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending === "approve"
            ? "Approving…"
            : `Approve all${approveAssetIds.length ? ` (${approveAssetIds.length})` : ""}`}
        </button>
      </div>
      {blockedCount > 0 ? (
        <span className="text-[11px] text-amber-700">
          {blockedCount} output{blockedCount === 1 ? "" : "s"} blocked by placeholders — fix &amp; re-run.
        </span>
      ) : null}
      {progress ? <span className="text-[11px] text-zinc-500">{progress}</span> : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}

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
          countNote={`${rejectAssetIds.length} pending output${rejectAssetIds.length === 1 ? "" : "s"} will be ignored.`}
          pending={pending === "ignore"}
          error={error}
          onCancel={() => setIgnoring(false)}
          onConfirm={ignoreAll}
        />
      ) : null}
    </div>
  );
}
