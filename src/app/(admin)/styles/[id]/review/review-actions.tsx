"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReviewActions({
  jobId,
  styleId,
  sharepointConfigured,
}: {
  jobId: string;
  styleId: string;
  sharepointConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/styles/${styleId}`);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function reject() {
    const reason = window.prompt("Reason for rejecting?");
    if (!reason || reason.trim() === "") return;
    setError(null);
    setPending("reject");
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/styles/${styleId}`);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reject}
          disabled={pending !== null}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
        {sharepointConfigured ? (
          <button
            type="button"
            onClick={approve}
            disabled={pending !== null}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {pending === "approve" ? "Approving…" : "Approve & publish"}
          </button>
        ) : (
          <span
            title="Set AZURE_CLIENT_ID + SHAREPOINT_SITE_ID to enable publishing"
            className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-500"
          >
            Approve disabled — SharePoint not configured
          </span>
        )}
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
