"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Asset = {
  id: string;
  docType: string;
  // Variant key uniquely identifies the asset across variants that
  // share a docType (e.g. care-label-01 and care-label-02 are both
  // CARE_LABEL). The preview endpoint prefers this over docType.
  variantKey: string | null;
  displayName: string;
  fileName: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectReason: string | null;
  reviewedAt: string | null;
  reviewerEmail: string | null;
};

const STATUS_PILL: Record<Asset["reviewStatus"], string> = {
  PENDING_REVIEW: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
};

export function DeliveredCard({
  jobId,
  asset,
}: {
  jobId: string;
  asset: Asset;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showReject, setShowReject] = useState(false);

  async function approve() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/job-assets/${asset.id}/approve`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Prefer variantKey — uniquely identifies the asset when multiple
  // variants on the same job share a docType (care-label-01 vs
  // care-label-02 both = CARE_LABEL). Fall back to docType for legacy
  // assets whose variantKey wasn't recorded.
  const previewQuery = asset.variantKey
    ? `variantKey=${encodeURIComponent(asset.variantKey)}`
    : `docType=${asset.docType}`;
  const previewUrl = `/api/admin/jobs/${jobId}/preview?${previewQuery}#zoom=fit&toolbar=0&navpanes=0`;

  return (
    <>
      <div
        className={`rounded-lg border bg-white p-3 ${
          asset.reviewStatus === "APPROVED"
            ? "border-emerald-200"
            : asset.reviewStatus === "REJECTED"
              ? "border-red-200"
              : "border-zinc-200"
        }`}
      >
        {/* Thumbnail. Fixed-size frame; the iframe fills it exactly and
            stays put on hover (no zoom). */}
        <div className="relative h-56 overflow-hidden rounded-md bg-zinc-50">
          <iframe
            src={previewUrl}
            title={asset.displayName}
            className="absolute inset-0 h-full w-full rounded-md bg-white shadow-sm"
          />
        </div>

        <div className="mt-3 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{asset.displayName}</div>
            <div className="truncate font-mono text-[10px] text-zinc-500">{asset.fileName}</div>
          </div>
          <span
            className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL[asset.reviewStatus]}`}
          >
            {asset.reviewStatus.replace("_", " ").toLowerCase()}
          </span>
        </div>

        {asset.reviewStatus === "REJECTED" && asset.rejectReason && (
          <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-800">
            <span className="font-semibold">Reason:</span> {asset.rejectReason}
          </div>
        )}

        {(asset.reviewedAt || asset.reviewerEmail) && (
          <div className="mt-2 text-[10px] text-zinc-500">
            {asset.reviewerEmail && <>by {asset.reviewerEmail} · </>}
            {asset.reviewedAt && new Date(asset.reviewedAt).toLocaleString("en-GB")}
          </div>
        )}

        {err && <p className="mt-2 text-[11px] text-red-600">{err}</p>}

        <div className="mt-3 flex gap-2">
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Open
          </a>
          <button
            type="button"
            onClick={approve}
            disabled={busy || asset.reviewStatus === "APPROVED"}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {asset.reviewStatus === "APPROVED" ? "Approved" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setShowReject(true)}
            disabled={busy}
            className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>

      {showReject && (
        <RejectDialog
          asset={asset}
          onClose={() => setShowReject(false)}
          onDone={() => {
            setShowReject(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

// Reject reason dialog. Suggestion buttons are pre-canned text the reviewer
// can click into the field — keeps reasons consistent for analytics without
// forcing categorisation yet.
const SUGGESTED_REASONS = [
  "Wrong dimensions",
  "Missing wash symbol",
  "Composition translation incorrect",
  "Barcode unreadable",
  "Wrong product name",
  "Wrong colour",
  "Wrong EAN",
];

function RejectDialog({
  asset,
  onClose,
  onDone,
}: {
  asset: Asset;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) {
      setErr("Reason is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/job-assets/${asset.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Reject {asset.displayName}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Reason is required and recorded for analytics. Use a suggestion below for consistency
              if it fits, or write your own.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          {SUGGESTED_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              {r}
            </button>
          ))}
        </div>

        <label className="block text-xs font-medium text-zinc-700">
          Reason *
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            placeholder="What's wrong with this file?"
          />
        </label>

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !reason.trim()}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
