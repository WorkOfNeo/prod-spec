"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Images tab for the prod spec editor. A drag-and-drop collection of images that
// render stacked — one after another, in this order — after the general-info
// text on the General page (inside the cover document of every bundle). Each
// image is uploaded immediately (bytes → Postgres) via the images routes; there
// is no autosave coupling. Reorder by dragging the cards; the order persists to
// `sortOrder`.

type GalleryImage = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sortOrder: number;
  url: string;
};

const MAX_BYTES = 5_000_000;

export function GeneralImagesPanel({ prodSpecId }: { prodSpecId: string }) {
  const base = `/api/admin/prod-specs/${prodSpecId}/images`;
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reorder state — index of the card being dragged + the hovered drop target.
  const dragFrom = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Fetch only — no setState — so both the mount effect and post-mutation
  // refetch can share it without tripping react-hooks/set-state-in-effect.
  const loadImages = useCallback(async (): Promise<GalleryImage[]> => {
    const res = await fetch(base, { cache: "no-store" });
    if (!res.ok) throw new Error(`Couldn't load images (HTTP ${res.status})`);
    const data = (await res.json()) as { images: GalleryImage[] };
    return data.images ?? [];
  }, [base]);

  // Post-mutation refetch (called from event handlers, never an effect).
  const refresh = useCallback(async () => {
    try {
      setImages(await loadImages());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadImages]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const imgs = await loadImages();
        if (active) {
          setImages(imgs);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadImages]);

  async function uploadFiles(files: File[]) {
    setError(null);
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) {
      setError("That wasn't an image file — drop a PNG, JPG, WebP, GIF or SVG.");
      return;
    }
    setUploading(true);
    try {
      for (const file of imgs) {
        if (file.size > MAX_BYTES) {
          setError(`"${file.name}" is too large (max 5 MB) — use a smaller image.`);
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const res = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl, fileName: file.name }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setError(body.error ? String(body.error) : `Upload failed (HTTP ${res.status})`);
          }
        } catch {
          setError(`Couldn't read "${file.name}"`);
        }
      }
      await refresh();
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    const prev = images;
    setImages((cur) => cur.filter((i) => i.id !== id)); // optimistic
    const res = await fetch(`${base}/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Couldn't delete that image.");
      setImages(prev);
    }
  }

  async function persistOrder(next: GalleryImage[]) {
    const prev = images;
    setImages(next); // optimistic
    const res = await fetch(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((i) => i.id) }),
    });
    if (!res.ok) {
      setError("Couldn't save the new order.");
      setImages(prev);
    }
  }

  // ---- File drop zone (Files only — ignores the internal reorder drag) ----
  function isFileDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }
  function onZoneDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onZoneDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onZoneDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onZoneDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    dragDepth.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void uploadFiles(files);
  }

  // ---- Card reorder (internal drag) ----
  function onCardDrop(toIndex: number) {
    const from = dragFrom.current;
    dragFrom.current = null;
    setOverIndex(null);
    if (from === null || from === toIndex) return;
    const next = [...images];
    const [moved] = next.splice(from, 1);
    next.splice(toIndex, 0, moved);
    void persistOrder(next);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-semibold text-zinc-700">General page images</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Drag images in (or click to browse). They render <strong>stacked, one after another</strong>,
          after the general-information text on the General page — which rides inside the cover page of
          every bundle. Drag the cards to reorder; changes save instantly. PNG, JPG, WebP, GIF or SVG,
          max&nbsp;5&nbsp;MB each.
        </p>

        <div
          onDragEnter={onZoneDragEnter}
          onDragLeave={onZoneDragLeave}
          onDragOver={onZoneDragOver}
          onDrop={onZoneDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-6 py-8 text-center transition ${
            dragOver
              ? "border-zinc-900 bg-zinc-900/5"
              : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 hover:bg-zinc-100/60"
          }`}
        >
          <span className="text-sm font-medium text-zinc-700">
            {uploading ? "Uploading…" : "Drop images here"}
          </span>
          <span className="text-xs text-zinc-500">or click to browse — you can add several at once</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void uploadFiles(files);
              e.target.value = ""; // allow re-picking the same file
            }}
          />
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-4">
          {loading ? (
            <p className="text-xs text-zinc-400">Loading…</p>
          ) : images.length === 0 ? (
            <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-xs text-zinc-500">
              No images yet — the General page shows the text only.
            </p>
          ) : (
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {images.map((img, i) => (
                <li
                  key={img.id}
                  draggable
                  onDragStart={() => {
                    dragFrom.current = i;
                  }}
                  onDragEnter={() => setOverIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onCardDrop(i)}
                  onDragEnd={() => {
                    dragFrom.current = null;
                    setOverIndex(null);
                  }}
                  className={`group relative flex flex-col overflow-hidden rounded-md border bg-white transition ${
                    overIndex === i ? "border-zinc-900 ring-2 ring-zinc-900/20" : "border-zinc-200"
                  }`}
                  title="Drag to reorder"
                >
                  <span className="absolute left-1 top-1 z-10 rounded bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(img.id)}
                    className="absolute right-1 top-1 z-10 rounded bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 opacity-0 transition hover:text-red-700 group-hover:opacity-100"
                    aria-label={`Delete ${img.fileName}`}
                    title="Delete"
                  >
                    ✕
                  </button>
                  <div className="flex h-28 cursor-grab items-center justify-center bg-zinc-50 active:cursor-grabbing">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.fileName}
                      draggable={false}
                      className="max-h-28 max-w-full object-contain"
                    />
                  </div>
                  <div className="truncate px-2 py-1 text-[10px] text-zinc-500" title={img.fileName}>
                    {img.fileName}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
