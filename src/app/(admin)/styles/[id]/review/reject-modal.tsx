"use client";

import { useState } from "react";
import { type PreparedImage } from "@/lib/images/downscale-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { CommentImagesTray, useCommentImages } from "./comment-images";

// Comment dialog for rejections (replaces window.prompt — comments are
// multi-line and feed the rejection log). Used by the job-level "Reject all";
// a single output is commented on in the review screen's own comment box.
// Reviewers can attach up to a few images (screenshots/photos of what's
// wrong) — resized in the browser before they ride along in the reject POST,
// and shown to the admin in the log.
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
  onConfirm: (comment: string, attachments: PreparedImage[]) => void;
}) {
  const [comment, setComment] = useState("");
  const images = useCommentImages();
  const trimmed = comment.trim();
  const busy = pending || images.preparing > 0;

  return (
    <Dialog
      onClose={onCancel}
      locked={pending}
      label={title}
      className={images.dragOver ? "ring-accent ring-2 ring-offset-2" : ""}
      {...images.dropTarget(busy)}
    >
      <DialogTitle title={title} context={context} />
      <textarea
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="What needs to change?"
        rows={4}
        className="border-line bg-surface text-ink placeholder:text-faint focus:border-accent mt-3 w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none"
      />
      <p className="text-muted mt-2 text-[12px]">
        Your comment goes into the rejection log with the full context (customer, business area,
        order, output) so an admin can work on it and re-run.
      </p>
      <div className="mt-2">
        <CommentImagesTray state={images} disabled={busy} />
      </div>

      {error ? <p className="text-bad mt-2 text-[12px]">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => onConfirm(trimmed, images.images)}
          disabled={busy || trimmed.length === 0}
        >
          {pending ? "Sending…" : "Request changes"}
        </Button>
      </div>
    </Dialog>
  );
}
