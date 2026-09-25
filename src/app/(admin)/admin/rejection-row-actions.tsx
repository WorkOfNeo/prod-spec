"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-row fix actions for /admin?tab=rejections — the same two flavours the
// rejection-log workbench offers, so a ticket can be cleared without leaving
// the oversight panel:
//   • regenerate=false → flip to FIXED + notify the reporter in-app, NO re-render.
//   • regenerate=true  → re-render the output first, then fix + notify.
// Only rendered for OPEN / IN_PROGRESS; the fix route rejects FIXED/RESOLVED.
export function RejectionRowActions({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"fix" | "regenFix" | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function fix(regenerate: boolean) {
    setError("");
    setNote("");
    setPending(regenerate ? "regenFix" : "fix");
    try {
      const res = await fetch(`/api/admin/rejection-tickets/${ticketId}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        removedOutput?: boolean;
        message?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // The output was dropped from the spec — resolved in place, no re-review.
      if (body.removedOutput) setNote(body.message ?? "Output is no longer in the prod spec — ticket resolved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void fix(false)}
        className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
        title="Mark this ticket fixed and notify the reviewer — WITHOUT re-rendering (use when the output is already up to date)"
      >
        {pending === "fix" ? "Fixing…" : "✓ Mark fixed & notify"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void fix(true)}
        className="whitespace-nowrap rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        title="Re-render this output, then mark it fixed and notify the reviewer"
      >
        {pending === "regenFix" ? "Regenerating…" : "↻ Regenerate & mark fixed"}
      </button>
      {error ? <span className="max-w-[15rem] text-[11px] text-rose-600">{error}</span> : null}
      {note ? <span className="max-w-[15rem] text-[11px] text-zinc-500">{note}</span> : null}
    </div>
  );
}
