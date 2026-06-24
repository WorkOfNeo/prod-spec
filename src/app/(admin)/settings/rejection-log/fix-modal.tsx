"use client";

import { useState } from "react";

// Optional-note dialog for "Mark fixed & notify" on the rejection log. The
// note (what the admin changed) rides along with the re-review notification
// + email to the reviewer and is kept on the ticket. Mirrors RejectModal,
// but the note is OPTIONAL — confirm stays enabled even when it's empty.
export function FixModal({
  context,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  context: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900">Mark fixed &amp; notify reviewer</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{context}</p>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What did you change? (optional — sent to the reviewer)"
          rows={4}
          maxLength={500}
          className="mt-3 w-full resize-y rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
        <p className="mt-2 text-xs text-zinc-500">
          Re-runs the output and tells the reviewer it&apos;s ready for another look. Your note (if any)
          goes into the in-app notification, the email, and the rejection log.
        </p>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note.trim())}
            disabled={pending}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {pending ? "Fixing…" : "✓ Mark fixed & notify"}
          </button>
        </div>
      </div>
    </div>
  );
}
