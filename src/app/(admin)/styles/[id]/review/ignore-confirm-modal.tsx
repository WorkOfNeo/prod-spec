"use client";

// Confirmation dialog for the Ignore decision (the third option between
// Reject and Approve). Ignoring is deliberately explained in full before it
// happens — it silently drops the output from everything downstream, so a
// mis-click must not slip through. Scope is always THIS style × THIS output;
// other styles on the same prod spec are untouched, and the action is undoable
// from the "Excluded / ignored" section on the review page.
export function IgnoreConfirmModal({
  title,
  context,
  countNote,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  context: string;
  // Bulk flavour: "3 pending outputs will be ignored." — null for single.
  countNote?: string | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
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

        {countNote ? <p className="mt-3 text-sm font-medium text-zinc-800">{countNote}</p> : null}

        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-relaxed text-zinc-700">
          <p className="font-semibold text-zinc-800">
            Ignoring applies to this style and this output only. The output will be:
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            <li>skipped in all future generations for this style</li>
            <li>left out of the SharePoint upload</li>
            <li>left out of the nightly supplier email</li>
          </ul>
          <p className="mt-1.5 text-zinc-500">
            Other styles on the same prod spec are unaffected. You can undo this later from the
            “Excluded / ignored” section on the review page.
          </p>
        </div>

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
            onClick={onConfirm}
            disabled={pending}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-900 disabled:opacity-50"
          >
            {pending ? "Ignoring…" : "Yes, ignore"}
          </button>
        </div>
      </div>
    </div>
  );
}
