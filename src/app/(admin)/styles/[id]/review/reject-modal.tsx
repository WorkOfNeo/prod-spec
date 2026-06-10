"use client";

import { useState } from "react";

// Comment dialog for rejections (replaces window.prompt — comments are
// multi-line and feed the rejection log). Used by the per-output Reject
// buttons and the job-level "Reject all".
export function RejectModal({
  title,
  context,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  context: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const trimmed = comment.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{context}</p>
        <textarea
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What's wrong with this output?"
          rows={4}
          maxLength={500}
          className="mt-3 w-full resize-y rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
        <p className="mt-2 text-xs text-zinc-500">
          Your comment goes into the rejection log with the full context (customer, business area,
          order, output) so an admin can work on it and re-run.
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
            onClick={() => onConfirm(trimmed)}
            disabled={pending || trimmed.length === 0}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? "Rejecting…" : "Reject output"}
          </button>
        </div>
      </div>
    </div>
  );
}
