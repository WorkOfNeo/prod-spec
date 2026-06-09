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
  // Set after a successful approve — the supplier-email recipients summary
  // returned by the route. Kept on screen (we don't auto-navigate) so the
  // To/CC can be confirmed, especially while email sending is off.
  const [result, setResult] = useState<EmailNotification | null>(null);

  async function approve() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/approve`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(body.notification ?? { to: null, cc: null, attachments: 0, folderUrl: null, sent: false });
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

  if (result) {
    return <ApprovedPanel result={result} styleId={styleId} />;
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

type EmailNotification = {
  to: string | null;
  cc: string | null;
  attachments: number;
  folderUrl: string | null;
  sent: boolean;
  note?: string;
};

// Shown after a successful approve. Confirms the supplier-email recipients
// (To / CC) and whether it was actually sent or just previewed (email
// sending off). Persisted copy also lands in the job log on the style page.
function ApprovedPanel({ result, styleId }: { result: EmailNotification; styleId: string }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
      <div className="font-semibold text-emerald-800">✓ Approved &amp; published</div>
      <div className="mt-2 text-zinc-700">
        {result.sent ? "Supplier email sent:" : "Supplier email — preview (sending is off):"}
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
      <a
        href={`/styles/${styleId}`}
        className="mt-3 inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
      >
        Back to style
      </a>
    </div>
  );
}
