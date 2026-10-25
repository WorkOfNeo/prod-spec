"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";

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
    <Dialog onClose={onCancel} locked={pending} label={title}>
      <DialogTitle title={title} context={context} />

      {countNote ? <p className="text-ink mt-3 text-[13px] font-medium">{countNote}</p> : null}

      <div className="border-line bg-subtle text-ink mt-3 rounded-md border px-3 py-2.5 text-[12px] leading-relaxed">
        <p className="font-medium">Ignoring applies to this style and this output only. The output will be:</p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          <li>skipped in all future generations for this style</li>
          <li>left out of the SharePoint upload</li>
          <li>left out of the nightly supplier email</li>
        </ul>
        <p className="text-muted mt-1.5">
          Other styles on the same prod spec are unaffected. You can undo this later from the
          “Excluded / ignored” section on the review page.
        </p>
      </div>

      {error ? <p className="text-bad mt-2 text-[12px]">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={pending}>
          {pending ? "Ignoring…" : "Yes, ignore"}
        </Button>
      </div>
    </Dialog>
  );
}
