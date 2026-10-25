"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Toggle } from "@/components/toggle";

// `logo` can hold raw SVG markup OR a data URL (PNG/JPG/SVG base64). This
// helper produces a data URL for any `<img src>` — as-is when it already
// is one, else by base64-encoding the SVG markup.
function asDataUrl(logo: string | null): string | null {
  if (!logo) return null;
  if (logo.startsWith("data:")) return logo;
  if (typeof window === "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(logo, "utf-8").toString("base64")}`;
  }
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(logo)))}`;
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

type Certificate = {
  id: string;
  name: string;
  logo: string | null;
  active: boolean;
};

export function CertificateList({ initialCertificates }: { initialCertificates: Certificate[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Certificate | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + New certificate
        </button>
        <span className="text-xs text-muted">
          The name must match what the style&apos;s certificates column emits (e.g.{" "}
          <code className="font-mono">FSC</code>).
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {initialCertificates.length === 0 ? (
          <div className="col-span-full rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
            No certificates yet. Click <strong>+ New certificate</strong> to add one (e.g. FSC,
            OEKO-TEX, GOTS).
          </div>
        ) : (
          initialCertificates.map((c) => (
            <CertificateCard key={c.id} certificate={c} onEdit={() => setEditing(c)} />
          ))
        )}
      </div>

      {creating && (
        <CertificateDialog
          title="New certificate"
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <CertificateDialog
          title={`Edit · ${editing.name}`}
          mode="edit"
          certificate={editing}
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

function CertificateCard({
  certificate,
  onEdit,
}: {
  certificate: Certificate;
  onEdit: () => void;
}) {
  const dataUrl = asDataUrl(certificate.logo);
  return (
    <div
      className={`rounded-lg border p-3 ${
        certificate.active ? "border-line bg-surface" : "border-transparent bg-warn-soft opacity-70"
      }`}
    >
      <div className="flex h-20 items-center justify-center rounded-md bg-subtle">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt={certificate.name} className="h-14 max-w-[80%] object-contain" />
        ) : (
          <span className="text-xs text-warn">no logo</span>
        )}
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{certificate.name}</div>
          {!certificate.active && <div className="text-xs text-warn">disabled</div>}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-subtle"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function CertificateDialog({
  title,
  mode,
  certificate,
  onClose,
  onSaved,
}: {
  title: string;
  mode: "create" | "edit";
  certificate?: Certificate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(certificate?.name ?? "");
  const [logo, setLogo] = useState(certificate?.logo ?? "");
  const [active, setActive] = useState(certificate?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);

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
    if (isSvg) {
      setLogo(await file.text());
    } else {
      setLogo(await readAsDataUrl(file));
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
        mode === "create" ? "/api/admin/certificates" : `/api/admin/certificates/${certificate!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const payload =
        mode === "create"
          ? { name, logo: logo || null }
          : { name, logo: logo || null, active };
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
    if (!certificate) return;
    if (!confirm(`Delete "${certificate.name}"? This is permanent — toggling Active off is safer.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/certificates/${certificate.id}`, { method: "DELETE" });
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

  const dataUrl = asDataUrl(logo);
  const storedAsDataUrl = !!logo && isDataUrl(logo);
  const dataUrlKind = storedAsDataUrl
    ? logo.startsWith("data:image/png")
      ? "PNG"
      : logo.startsWith("data:image/jpeg")
        ? "JPG"
        : logo.startsWith("data:image/svg+xml")
          ? "SVG (encoded)"
          : "image"
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(15_17_21/0.40)] px-4">
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative w-full max-w-xl rounded-lg bg-surface p-6 shadow-2xl transition-shadow ${
          dragOver ? "ring-4 ring-accent ring-offset-2" : ""
        }`}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-900/5">
            <div className="rounded-md border-2 border-dashed border-ink bg-white/95 px-6 py-4 text-center text-sm font-medium text-ink">
              Drop SVG / PNG / JPG to attach
            </div>
          </div>
        )}
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-muted underline">
            close
          </button>
        </div>

        <label className="block text-xs font-medium text-ink">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm"
            placeholder="FSC"
          />
          <span className="mt-1 block font-normal text-muted">
            Must match the certificate name on the style (case-insensitive).
          </span>
        </label>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-ink">
              Logo file (SVG, PNG, or JPG — drop anywhere in this dialog)
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
            <span className="mt-1 block text-[11px] text-muted">
              SVG is preferred — vector, crisp at any print size. Max 1 MB.
            </span>

            {storedAsDataUrl ? (
              <div className="mt-3 rounded-md border border-line bg-subtle p-3 text-xs text-muted">
                <div>
                  Uploaded as <strong>{dataUrlKind}</strong>{" "}
                  <span className="text-muted">({Math.round(logo.length / 1024)} KB)</span>
                </div>
                <button
                  type="button"
                  onClick={() => setLogo("")}
                  className="mt-2 inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-subtle hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear and replace
                </button>
              </div>
            ) : (
              <label className="mt-3 block text-xs font-medium text-ink">
                Or paste SVG markup
                <textarea
                  value={logo}
                  onChange={(e) => setLogo(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-[11px]"
                  placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>'}
                />
              </label>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-ink">Preview</div>
            <div className="mt-1 flex h-40 items-center justify-center rounded-md border border-line bg-subtle">
              {dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="preview" className="max-h-32 max-w-[80%] object-contain" />
              ) : (
                <span className="text-xs text-muted">no logo yet</span>
              )}
            </div>
            {mode === "edit" && (
              <div className="mt-3">
                <Toggle checked={active} onChange={setActive} label={active ? "Active" : "Disabled"} />
              </div>
            )}
          </div>
        </div>

        {err && <p className="mt-3 text-xs text-bad">{err}</p>}

        <div className="mt-5 flex items-center justify-between">
          <div>
            {mode === "edit" && (
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="text-xs text-bad underline disabled:opacity-50"
              >
                Delete permanently
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !name}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
