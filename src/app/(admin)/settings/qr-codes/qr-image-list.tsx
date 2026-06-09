"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

// `image` holds a data URL (PNG/JPG/SVG base64) or raw SVG markup. This
// helper returns a data URL for any `<img src>`.
function asDataUrl(image: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return image;
  if (typeof window === "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(image, "utf-8").toString("base64")}`;
  }
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(image)))}`;
}

type QrImage = {
  id: string;
  name: string;
  image: string;
  active: boolean;
};

export function QrImageList({ initialQrImages }: { initialQrImages: QrImage[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<QrImage | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New QR image
        </button>
        <span className="text-xs text-zinc-500">
          Upload the QR picture, then link it to a style from the style&apos;s edit page.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {initialQrImages.length === 0 ? (
          <div className="col-span-full rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            No QR images yet. Click <strong>+ New QR image</strong> to upload one.
          </div>
        ) : (
          initialQrImages.map((q) => (
            <QrImageCard key={q.id} qrImage={q} onEdit={() => setEditing(q)} />
          ))
        )}
      </div>

      {creating && (
        <QrImageDialog
          title="New QR image"
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <QrImageDialog
          title={`Edit · ${editing.name}`}
          mode="edit"
          qrImage={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function QrImageCard({ qrImage, onEdit }: { qrImage: QrImage; onEdit: () => void }) {
  const dataUrl = asDataUrl(qrImage.image);
  return (
    <div
      className={`rounded-lg border p-3 ${
        qrImage.active ? "border-zinc-200 bg-white" : "border-amber-300 bg-amber-50 opacity-70"
      }`}
    >
      <div className="flex h-24 items-center justify-center rounded-md bg-zinc-50">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={qrImage.name} className="h-20 w-20 object-contain" />
        ) : (
          <span className="text-xs text-amber-700">no image</span>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{qrImage.name}</div>
          {!qrImage.active && <div className="text-xs text-amber-700">disabled</div>}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function QrImageDialog({
  title,
  mode,
  qrImage,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  qrImage?: QrImage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(qrImage?.name ?? "");
  const [image, setImage] = useState(qrImage?.image ?? "");
  const [active, setActive] = useState(qrImage?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);

  async function readFile(file: File) {
    if (file.size > 1_000_000) {
      setErr("File too large (max 1 MB)");
      return;
    }
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
    const isJpg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
    if (!isSvg && !isPng && !isJpg) {
      setErr(`Expected SVG, PNG, or JPG — got "${file.name}" (${file.type || "no type"})`);
      return;
    }
    if (isSvg) {
      setImage(await file.text());
    } else {
      setImage(await readAsDataUrl(file));
    }
    setErr(null);
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragDepth((d) => {
      const next = d - 1;
      if (next <= 0) setDragOver(false);
      return Math.max(next, 0);
    });
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    setDragDepth(0);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const url =
        mode === "create" ? "/api/admin/qr-images" : `/api/admin/qr-images/${qrImage!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload =
        mode === "create" ? { name, image } : { name, image, active };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ? `${body.error}` : `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!qrImage) return;
    if (!confirm(`Delete "${qrImage.name}"? This is permanent — toggling Active off is safer.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/qr-images/${qrImage.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const dataUrl = asDataUrl(image);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative w-full max-w-xl rounded-lg bg-white p-6 shadow-2xl transition-shadow ${
          dragOver ? "ring-4 ring-zinc-900 ring-offset-2" : ""
        }`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-900/5">
            <div className="rounded-md border-2 border-dashed border-zinc-900 bg-white/95 px-6 py-4 text-center text-sm font-medium text-zinc-900">
              Drop SVG / PNG / JPG to attach
            </div>
          </div>
        )}
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        <label className="block text-xs font-medium text-zinc-700">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            placeholder="e.g. Care guide QR"
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-zinc-700">
              QR image (SVG, PNG, or JPG — drop anywhere in this dialog)
            </label>
            <input
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
              className="mt-1 block w-full text-xs"
            />
            <span className="mt-1 block text-[10px] text-zinc-500">Max 1 MB.</span>
          </div>
          <div>
            <div className="text-xs font-medium text-zinc-700">Preview</div>
            <div className="mt-1 flex h-40 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="preview" className="h-32 w-32 object-contain" />
              ) : (
                <span className="text-xs text-zinc-500">no image yet</span>
              )}
            </div>
            {mode === "edit" && (
              <div className="mt-3">
                <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
              </div>
            )}
          </div>
        </div>

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="text-xs text-red-700 underline disabled:opacity-50"
              >
                Delete permanently
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !name || !image}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
