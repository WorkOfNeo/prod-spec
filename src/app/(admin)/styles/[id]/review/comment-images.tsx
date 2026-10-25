"use client";

import { Paperclip, X } from "lucide-react";
import { useState, type ChangeEvent, type DragEvent } from "react";
import { downscaleImage, type PreparedImage } from "@/lib/images/downscale-image";

// Images a reviewer attaches to a rejection comment — picked or dropped,
// resized in the browser before upload. Shared by the review screen's comment
// box and the reject dialog, so both accept the same files the same way.

const MAX_ATTACHMENTS = 4;
const ACCEPT = "image/png,image/jpeg,image/webp";

export function useCommentImages() {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const full = images.length >= MAX_ATTACHMENTS;

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

  function removeAt(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
    setFileError(null);
  }

  function reset() {
    setImages([]);
    setFileError(null);
  }

  // Spread onto the element that accepts a drop (the dialog, the comment box).
  function dropTarget(disabled: boolean) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        if (!disabled && !full && !dragOver) setDragOver(true);
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled || full) return;
        void addFiles(Array.from(e.dataTransfer?.files ?? []));
      },
    };
  }

  return { images, preparing, fileError, dragOver, full, onPick, removeAt, reset, dropTarget };
}

export type CommentImages = ReturnType<typeof useCommentImages>;

/** Thumbnails of what's attached, and the attach button. */
export function CommentImagesTray({ state, disabled }: { state: CommentImages; disabled: boolean }) {
  const { images, preparing, fileError, dragOver, full, onPick, removeAt } = state;
  return (
    <div>
      {images.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div
              key={`${img.fileName}-${i}`}
              className="border-line bg-subtle relative size-14 overflow-hidden rounded-md border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
              <img src={img.dataUrl} alt={img.fileName} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => removeAt(i)}
                disabled={disabled}
                title="Remove"
                aria-label={`Remove ${img.fileName}`}
                className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-[rgb(15_17_21/0.6)] text-white disabled:opacity-50"
              >
                <X size={10} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <label
          className={`text-muted inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium ${
            disabled || full ? "cursor-not-allowed opacity-50" : "hover:bg-subtle hover:text-ink cursor-pointer"
          }`}
        >
          <input type="file" accept={ACCEPT} multiple className="hidden" onChange={onPick} disabled={disabled || full} />
          <Paperclip size={13} aria-hidden="true" />
          {images.length > 0 ? `Images · ${images.length}/${MAX_ATTACHMENTS}` : "Attach image"}
        </label>
        {preparing > 0 ? (
          <span className="text-muted text-[12px]">Preparing…</span>
        ) : dragOver ? (
          <span className="text-accent-text text-[12px] font-medium">Drop to attach</span>
        ) : !full ? (
          <span className="text-faint text-[12px]">or drop a screenshot</span>
        ) : null}
      </div>
      {fileError ? <p className="text-warn mt-1 text-[12px]">{fileError}</p> : null}
    </div>
  );
}
