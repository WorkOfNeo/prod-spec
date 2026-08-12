"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Toggle } from "@/components/toggle";
import { IMAGE_SLUG_RE, slugifyImageName } from "@/lib/output-layouts/image-slug";

// `image` holds raw SVG markup OR a data URL (PNG/JPG/SVG base64). This
// helper produces a data URL for any `<img src>` — as-is when it already is
// one, else by base64-encoding the SVG markup. Same as the certificates page.
function asDataUrl(image: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return image;
  if (typeof window === "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(image, "utf-8").toString("base64")}`;
  }
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(image)))}`;
}

type LayoutImage = {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  active: boolean;
  // Names of the layouts whose definition places {{image:<slug>}}.
  usedBy: string[];
};

export function ImageList({ initialImages }: { initialImages: LayoutImage[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<LayoutImage | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          + New image
        </button>
        <span className="text-xs text-zinc-500">
          Each picture gets a short name you type in the token, e.g.{" "}
          <code className="font-mono">coop-hanger</code>.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {initialImages.length === 0 ? (
          <div className="col-span-full rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            No images yet. Click <strong>+ New image</strong> to add one — a supplier mark, a pictogram,
            a customer logo an output needs alongside its own.
          </div>
        ) : (
          initialImages.map((img) => (
            <ImageCard key={img.id} image={img} onEdit={() => setEditing(img)} />
          ))
        )}
      </div>

      {creating && (
        <ImageDialog
          title="New image"
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <ImageDialog
          title={`Edit · ${editing.name}`}
          mode="edit"
          image={editing}
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

function ImageCard({ image, onEdit }: { image: LayoutImage; onEdit: () => void }) {
  const dataUrl = asDataUrl(image.image);
  return (
    <div
      className={`rounded-lg border p-3 ${
        image.active ? "border-zinc-200 bg-white" : "border-amber-300 bg-amber-50 opacity-70"
      }`}
    >
      <div className="flex h-20 items-center justify-center rounded-md bg-zinc-50">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={image.name} className="h-14 max-w-[80%] object-contain" />
        ) : (
          <span className="text-xs text-amber-700">no artwork</span>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{image.name}</div>
          <code className="block truncate font-mono text-[11px] text-zinc-500">
            {`{{image:${image.slug}}}`}
          </code>
          {!image.active && <div className="text-xs text-amber-700">disabled — prints a placeholder</div>}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Edit
        </button>
      </div>
      <div className="mt-2 text-[11px] text-zinc-500" title={image.usedBy.join("\n")}>
        {image.usedBy.length === 0
          ? "Not placed on any layout yet"
          : `On ${image.usedBy.length} layout${image.usedBy.length === 1 ? "" : "s"}: ${image.usedBy
              .slice(0, 3)
              .join(", ")}${image.usedBy.length > 3 ? ` +${image.usedBy.length - 3} more` : ""}`}
      </div>
    </div>
  );
}

function ImageDialog({
  title,
  mode,
  image,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  image?: LayoutImage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(image?.name ?? "");
  const [slug, setSlug] = useState(image?.slug ?? "");
  // A slug the operator hasn't touched keeps following the name; once they
  // edit it by hand it stops moving under them. On an existing row the slug
  // is already the contract with published layouts, so it never auto-follows.
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [artwork, setArtwork] = useState(image?.image ?? "");
  const [active, setActive] = useState(image?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Drag enter/leave fire for every child element, so the overlay is driven
  // by a depth counter. It never affects rendering — a ref, not state.
  const dragDepth = useRef(0);

  const slugChanged = mode === "edit" && slug !== image!.slug;
  const usedBy = image?.usedBy ?? [];

  async function readFile(file: File) {
    if (file.size > 1_000_000) {
      setErr("File too large (max 1 MB)");
      return;
    }
    // Accept by extension OR mime type — Finder drags sometimes report an
    // empty type. SVG preferred (vector); PNG / JPG accepted for bitmap art.
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
    const isJpg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
    if (!isSvg && !isPng && !isJpg) {
      setErr(`Expected SVG, PNG, or JPG — got "${file.name}" (${file.type || "no type"})`);
      return;
    }
    setArtwork(isSvg ? await file.text() : await readAsDataUrl(file));
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
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(dragDepth.current - 1, 0);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    dragDepth.current = 0;
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  async function save(force = false) {
    setBusy(true);
    setErr(null);
    try {
      const base =
        mode === "create" ? "/api/admin/layout-images" : `/api/admin/layout-images/${image!.id}`;
      const url = force ? `${base}?force=1` : base;
      const payload =
        mode === "create"
          ? { name, slug, image: artwork || null }
          : { name, slug, image: artwork || null, active };
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A rename that would orphan layouts comes back 409 with the list —
        // confirm, then repeat the write with ?force=1.
        if (res.status === 409 && Array.isArray(body.layouts) && body.layouts.length > 0) {
          const ok = confirm(
            `${body.error}\n\n${body.layouts.join("\n")}\n\nRename anyway? You'll need to repoint each layout.`,
          );
          if (ok) {
            setBusy(false);
            return save(true);
          }
          setErr(body.error);
          return;
        }
        setErr(body.error ? `${body.error}` : `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function destroy(force = false) {
    if (!image) return;
    if (!force && !confirm(`Delete "${image.name}"? Toggling Active off is not safer — both make layouts print a placeholder.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/layout-images/${image.id}${force ? "?force=1" : ""}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && Array.isArray(body.layouts) && body.layouts.length > 0) {
          const ok = confirm(`${body.error}\n\n${body.layouts.join("\n")}\n\nDelete anyway?`);
          if (ok) {
            setBusy(false);
            return destroy(true);
          }
          setErr(body.error);
          return;
        }
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const dataUrl = asDataUrl(artwork);
  const storedAsDataUrl = !!artwork && artwork.startsWith("data:");
  const dataUrlKind = storedAsDataUrl
    ? artwork.startsWith("data:image/png")
      ? "PNG"
      : artwork.startsWith("data:image/jpeg")
        ? "JPG"
        : artwork.startsWith("data:image/svg+xml")
          ? "SVG (encoded)"
          : "image"
    : null;
  const slugValid = IMAGE_SLUG_RE.test(slug);

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

        <div className="grid grid-cols-2 gap-4">
          <label className="block text-xs font-medium text-zinc-700">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugifyImageName(e.target.value));
              }}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="Coop hanger mark"
            />
            <span className="mt-1 block font-normal text-zinc-500">Shown in the builder palette.</span>
          </label>
          <label className="block text-xs font-medium text-zinc-700">
            Token name
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-sm ${
                slug && !slugValid ? "border-red-400" : "border-zinc-300"
              }`}
              placeholder="coop-hanger"
            />
            <span className="mt-1 block font-normal text-zinc-500">
              {slug && !slugValid
                ? "Lowercase letters, digits and hyphens only."
                : slug
                  ? `Place it with {{image:${slug}}}`
                  : "Lowercase letters, digits and hyphens."}
            </span>
          </label>
        </div>

        {slugChanged && usedBy.length > 0 && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {usedBy.length} layout{usedBy.length === 1 ? "" : "s"} place{" "}
            <code className="font-mono">{`{{image:${image!.slug}}}`}</code>. Renaming means repointing
            each one — until then they print a placeholder, which blocks approval.
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-zinc-700">
              Artwork (SVG, PNG, or JPG — drop anywhere in this dialog)
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
            <span className="mt-1 block text-[10px] text-zinc-500">
              SVG is preferred — vector, crisp at any print size. Max 1 MB.
            </span>

            {storedAsDataUrl ? (
              <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                <div>
                  Uploaded as <strong>{dataUrlKind}</strong>{" "}
                  <span className="text-zinc-500">({Math.round(artwork.length / 1024)} KB)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setArtwork("")}
                  className="mt-2 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium hover:bg-zinc-50"
                >
                  Clear and replace
                </button>
              </div>
            ) : (
              <label className="mt-3 block text-xs font-medium text-zinc-700">
                Or paste SVG markup
                <textarea
                  value={artwork}
                  onChange={(e) => setArtwork(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-[10px]"
                  placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>'}
                />
              </label>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-zinc-700">Preview</div>
            <div className="mt-1 flex h-40 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="preview" className="max-h-32 max-w-[80%] object-contain" />
              ) : (
                <span className="text-xs text-zinc-500">no artwork yet</span>
              )}
            </div>
            {mode === "edit" && (
              <div className="mt-3">
                <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
                <p className="mt-1 text-[10px] text-zinc-500">
                  A disabled picture prints the same placeholder a missing one does.
                </p>
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
                onClick={() => void destroy()}
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
              onClick={() => void save()}
              disabled={busy || !name || !slugValid}
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
