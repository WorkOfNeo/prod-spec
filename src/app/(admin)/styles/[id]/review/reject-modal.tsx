"use client";

import { useState, type ChangeEvent, type DragEvent } from "react";
import { downscaleImage, type PreparedImage } from "@/lib/images/downscale-image";

// Comment dialog for rejections (replaces window.prompt — comments are
// multi-line and feed the rejection log). Used by the per-output Reject
// buttons and the job-level "Reject all". Reviewers can attach up to a few
// images (screenshots/photos of what's wrong) — resized in the browser before
// they ride along in the reject POST, and shown to the admin in the log.
const MAX_ATTACHMENTS = 4;
const ACCEPT = "image/png,image/jpeg,image/webp";

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
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const trimmed = comment.trim();
  const busy = pending || preparing > 0;
  const full = images.length >= MAX_ATTACHMENTS;

  // Shared resize-and-attach path for both the file picker and drag-and-drop.
  // Drag-drop can deliver anything, so filter to the image types we accept.
  async function addFiles(picked: File[]) {
    if (picked.length === 0) return;
    setFileError(null);
    const accepted = picked.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (accepted.length === 0) {
      setFileError("Only PNG, JPEG or WebP images can be attached.");
      return;
    }
    const room = MAX_ATTACHMENTS - images.length;
    if (room <= 0) {
      setFileError(`Up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    const take = accepted.slice(0, room);
    if (accepted.length > room) {
      setFileError(`Added the first ${room} — max ${MAX_ATTACHMENTS} images.`);
    }
    setPreparing((n) => n + take.length);
    for (const file of take) {
      try {
        const prepared = await downscaleImage(file);
        setImages((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, prepared]));
      } catch {
        setFileError("Couldn't read one of those images — try a PNG or JPEG.");
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be re-picked after a remove
    void addFiles(picked);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (busy || full) return;
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  function removeAt(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
    setFileError(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      // Swallow drops that miss the popover so the browser doesn't navigate to
      // the dropped image file.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        className={`w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl transition ${
          dragOver ? "ring-2 ring-red-400 ring-offset-2" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy && !full && !dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          // Ignore drag-leave bubbling from children — only clear when the
          // pointer actually leaves the popover.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{context}</p>
        <textarea
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What's wrong with this output?"
          rows={4}
          className="mt-3 w-full resize-y rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-900 focus:outline-none"
        />
        <p className="mt-2 text-xs text-zinc-500">
          Your comment goes into the rejection log with the full context (customer, business area,
          order, output) so an admin can work on it and re-run.
        </p>

        {/* Image attachments — optional, resized in the browser before upload. */}
        <div className="mt-3">
          {images.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div
                  key={`${img.fileName}-${i}`}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
                  <img src={img.dataUrl} alt={img.fileName} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    disabled={busy}
                    title="Remove"
                    aria-label={`Remove ${img.fileName}`}
                    className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[11px] leading-none text-white hover:bg-black/80 disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <label
              className={`inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 ${
                busy || full ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-zinc-50"
              }`}
            >
              <input
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={onPick}
                disabled={busy || full}
              />
              📎 Attach image{images.length > 0 ? `s · ${images.length}/${MAX_ATTACHMENTS}` : ""}
            </label>
            {preparing > 0 ? (
              <span className="text-xs text-zinc-500">Preparing…</span>
            ) : dragOver ? (
              <span className="text-xs font-medium text-red-500">Drop to attach</span>
            ) : !full ? (
              <span className="text-xs text-zinc-400">or drag &amp; drop</span>
            ) : null}
          </div>
          {fileError ? <p className="mt-1 text-xs text-amber-600">{fileError}</p> : null}
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
            onClick={() => onConfirm(trimmed, images)}
            disabled={busy || trimmed.length === 0}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? "Rejecting…" : "Reject output"}
          </button>
        </div>
      </div>
    </div>
  );
}
