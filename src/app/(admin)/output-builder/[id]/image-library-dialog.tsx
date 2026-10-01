"use client";

import { useEffect, useRef, useState } from "react";
import { IMAGE_SLUG_RE, slugifyImageName } from "@/lib/output-layouts/image-slug";

// =====================================================
// The image library, inside the Output Builder.
//
// The library lives at /settings/images, but an operator placing a picture
// is mid-design — sending them to another page to upload one loses the
// thread. This dialog is the same library, reachable without leaving the
// layout: browse what exists and insert it, or upload artwork on the spot.
//
// Its second job is the one that matters more. Typing {{image:whatever}}
// is a perfectly valid thing to do BEFORE the artwork exists — the token
// validates by shape, not against the library. The editor spots such a
// slug and opens this dialog in "upload for this token" mode, so the
// picture arrives under the name the operator already typed instead of
// them having to invent a matching one in a different tab.
// =====================================================

export type LibraryImage = { slug: string; name: string; dataUrl: string | null };

// Raw SVG markup or a data URL in, a data URL out — for <img src>.
function asDataUrl(image: string): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return image;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(image)))}`;
}

export function ImageLibraryDialog({
  images,
  // Slug the operator already typed in a token but which has no artwork.
  // Present ⇒ the dialog opens straight into upload, name locked to it.
  forSlug,
  canInsert,
  onInsert,
  onSaved,
  onClose,
}: {
  images: LibraryImage[];
  forSlug?: string | null;
  canInsert: boolean;
  onInsert: (token: string) => void;
  onSaved: (image: LibraryImage) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"browse" | "upload">(forSlug ? "upload" : "browse");
  const [name, setName] = useState(forSlug ?? "");
  const [slug, setSlug] = useState(forSlug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!forSlug);
  const [artwork, setArtwork] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  // Esc closes — the dialog is a quick detour from designing, not a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      setErr(`Expected SVG, PNG or JPG — got "${file.name}" (${file.type || "no type"})`);
      return;
    }
    setArtwork(
      isSvg
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
            reader.readAsDataURL(file);
          }),
    );
    // A dropped file names the picture when the operator hasn't.
    if (!name && !forSlug) {
      const base = file.name.replace(/\.[^.]+$/, "");
      setName(base);
      if (!slugTouched) setSlug(slugifyImageName(base));
    }
    setErr(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/layout-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || slug, slug, image: artwork || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const saved: LibraryImage = {
        slug,
        name: name || slug,
        dataUrl: artwork ? asDataUrl(artwork) : null,
      };
      onSaved(saved);
      // Uploading FOR a token the layout already places means the token is
      // already on the page — inserting again would duplicate it.
      if (!forSlug && canInsert) onInsert(`{{image:${slug}}}`);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const slugValid = IMAGE_SLUG_RE.test(slug);
  const taken = images.some((i) => i.slug === slug);
  const preview = artwork ? asDataUrl(artwork) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
          setMode("upload");
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(dragDepth.current - 1, 0);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          dragDepth.current = 0;
          const file = e.dataTransfer.files?.[0];
          if (file) void readFile(file);
        }}
        className={`relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white p-5 shadow-2xl ${
          dragOver ? "ring-4 ring-zinc-900 ring-offset-2" : ""
        }`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-zinc-900/5">
            <div className="rounded-md border-2 border-dashed border-zinc-900 bg-white/95 px-6 py-4 text-sm font-medium">
              Drop SVG / PNG / JPG to add it to the library
            </div>
          </div>
        )}

        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Images</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
              Place a picture with{" "}
              <code className="rounded bg-zinc-100 px-1 font-mono">{"{{image:name}}"}</code> — as many
              as an output needs. Pictures are shared, so the same one can sit on any number of
              layouts and correcting it here corrects all of them. Add a width to size one:{" "}
              <code className="rounded bg-zinc-100 px-1 font-mono">{"{{image:name:40}}"}</code>{" "}
              prints it at 40% of its block&apos;s width.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 underline">
            close
          </button>
        </div>

        {forSlug && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
            This layout places{" "}
            <code className="font-mono">{`{{image:${forSlug}}}`}</code>{" "}
            but the library has no picture by that name, so it prints a placeholder that blocks approval. Upload the artwork below
            and it&apos;s saved under exactly that name — no need to change the token.
          </p>
        )}

        {!forSlug && (
          <div className="mb-3 flex gap-1 border-b border-zinc-200 text-xs">
            {(["browse", "upload"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`-mb-px border-b-2 px-3 py-1.5 font-medium ${
                  mode === m
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {m === "browse" ? `Gallery (${images.length})` : "Upload new"}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {mode === "browse" ? (
            images.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
                No pictures yet.{" "}
                <button
                  type="button"
                  onClick={() => setMode("upload")}
                  className="font-medium text-zinc-900 underline"
                >
                  Upload one
                </button>{" "}
                — or just drop a file anywhere in this dialog.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {images.map((img) => (
                  <button
                    key={img.slug}
                    type="button"
                    disabled={!canInsert}
                    onClick={() => {
                      onInsert(`{{image:${img.slug}}}`);
                      onClose();
                    }}
                    title={
                      canInsert
                        ? `Insert {{image:${img.slug}}} at the cursor`
                        : "Select a block first"
                    }
                    className="group rounded-lg border border-zinc-200 p-2 text-left hover:border-zinc-900 disabled:opacity-50 disabled:hover:border-zinc-200"
                  >
                    <div className="flex h-16 items-center justify-center rounded bg-zinc-50">
                      {img.dataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img.dataUrl} alt="" className="max-h-12 max-w-[80%] object-contain" />
                      ) : (
                        <span className="text-[10px] text-amber-700">no artwork</span>
                      )}
                    </div>
                    <div className="mt-1.5 truncate text-xs font-medium">{img.name}</div>
                    <code className="block truncate font-mono text-[10px] text-zinc-500">
                      {`{{image:${img.slug}}}`}
                    </code>
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                {!forSlug && (
                  <>
                    <label className="block text-xs font-medium text-zinc-700">
                      Name
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          if (!slugTouched) setSlug(slugifyImageName(e.target.value));
                        }}
                        placeholder="Coop hanger mark"
                        className="mt-1 w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm"
                      />
                    </label>
                    <label className="mt-2 block text-xs font-medium text-zinc-700">
                      Token name
                      <input
                        type="text"
                        value={slug}
                        onChange={(e) => {
                          setSlugTouched(true);
                          setSlug(e.target.value.toLowerCase());
                        }}
                        placeholder="coop-hanger"
                        className={`mt-1 w-full rounded-md border px-2.5 py-1.5 font-mono text-sm ${
                          slug && (!slugValid || taken) ? "border-red-400" : "border-zinc-300"
                        }`}
                      />
                    </label>
                    <p className="mt-1 text-[10px] text-zinc-500">
                      {slug && !slugValid
                        ? "Lowercase letters, digits and hyphens only."
                        : taken
                          ? "Already in the library — pick another name."
                          : slug
                            ? `Places as {{image:${slug}}}`
                            : "Lowercase letters, digits and hyphens."}
                    </p>
                  </>
                )}

                <label className="mt-3 block text-xs font-medium text-zinc-700">
                  Artwork
                  <input
                    type="file"
                    accept="image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readFile(file);
                    }}
                    className="mt-1 block w-full text-xs"
                  />
                </label>
                <p className="mt-1 text-[10px] text-zinc-500">
                  SVG is preferred — vector, crisp at any print size. Max 1 MB. You can also drop a
                  file anywhere in this dialog.
                </p>
                {artwork && !artwork.startsWith("data:") && (
                  <p className="mt-1 text-[10px] text-zinc-500">SVG markup loaded.</p>
                )}
              </div>
              <div>
                <div className="text-xs font-medium text-zinc-700">Preview</div>
                <div className="mt-1 flex h-32 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview} alt="preview" className="max-h-24 max-w-[80%] object-contain" />
                  ) : (
                    <span className="text-xs text-zinc-500">nothing chosen yet</span>
                  )}
                </div>
                {forSlug && (
                  <p className="mt-2 text-[10px] text-zinc-500">
                    Saves as{" "}
                    <code className="font-mono">{`{{image:${forSlug}}}`}</code>.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

        <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-3">
          <a
            href="/settings/images"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-zinc-500 underline hover:text-zinc-800"
          >
            Full library (rename, replace, delete) →
          </a>
          {mode === "upload" && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !slugValid || taken || !artwork}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy ? "Saving…" : forSlug ? "Upload artwork" : "Save & place"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
