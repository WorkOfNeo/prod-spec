"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Admin-only "Push all approved" control on the review screen header. Sends
// every approved, print-safe output for the style into the supplier's
// SharePoint folder in one request. Sits beside OutputBulkActions (which only
// renders when there's something to approve/reject), so a fully-approved style
// still gets a push affordance. Rendered only for admins (the page gates on
// isAdmin); the endpoint enforces the same.
export function SupplierPushActions({
  styleId,
  pushableCount,
}: {
  styleId: string;
  pushableCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [folderUrl, setFolderUrl] = useState<string | null>(null);

  if (pushableCount === 0) return null;

  async function pushAll() {
    setError(null);
    setNote(null);
    setFolderUrl(null);
    setPending(true);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/push-to-supplier`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        pushed?: Array<{ fileName: string; webUrl: string | null }>;
        folderName?: string;
        targetFolderUrl?: string | null;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const n = body.pushed?.length ?? 0;
      setNote(`Pushed ${n} output${n === 1 ? "" : "s"} to ${body.folderName ?? "the supplier folder"}`);
      setFolderUrl(body.targetFolderUrl ?? null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={pushAll}
        disabled={pending}
        title="Create the supplier's SharePoint subfolder and upload every approved output"
        className="rounded-md border border-sky-300 bg-sky-50 px-4 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
      >
        {pending ? "Pushing…" : `⬆ Push all approved (${pushableCount})`}
      </button>
      {note ? (
        <span className="text-right text-xs text-sky-700">
          {note}
          {folderUrl ? (
            <>
              {" · "}
              <a href={folderUrl} target="_blank" rel="noopener noreferrer" className="underline">
                open folder
              </a>
            </>
          ) : null}
        </span>
      ) : null}
      {error ? <span className="max-w-72 text-right text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
