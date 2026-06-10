"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

type LayoutRow = {
  id: string;
  name: string;
  docType: string;
  status: "DRAFT" | "PUBLISHED";
  version: number;
  pageCount: number;
  dims: string;
  customerName: string | null;
  businessAreaName: string | null;
  updatedAt: string;
};

export function LayoutsList({
  layouts,
  contrastLogoFound,
  customLogo,
}: {
  layouts: LayoutRow[];
  contrastLogoFound: boolean;
  customLogo: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function uploadLogo(file: File) {
    setLogoError(null);
    if (file.size > 450_000) {
      setLogoError("Keep the logo under ~450 KB.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("could not read file"));
      r.readAsDataURL(file);
    });
    const res = await fetch("/api/admin/output-layouts/logo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setLogoError(body.error ?? `HTTP ${res.status}`);
      return;
    }
    router.refresh();
  }

  async function removeLogo() {
    setLogoError(null);
    await fetch("/api/admin/output-layouts/logo", { method: "DELETE" });
    router.refresh();
  }

  async function createLayout() {
    setBusy("new");
    setError(null);
    try {
      const res = await fetch("/api/admin/output-layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: { id: string }; error?: string };
      if (!res.ok || !body.layout) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/output-builder/${body.layout.id}`);
    } finally {
      setBusy(null);
    }
  }

  async function duplicateLayout(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/output-layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duplicateFromId: id }),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: { id: string }; error?: string };
      if (!res.ok || !body.layout) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/output-builder/${body.layout.id}`);
    } finally {
      setBusy(null);
    }
  }

  async function deleteLayout(row: LayoutRow) {
    const warning =
      row.status === "PUBLISHED"
        ? `Delete "${row.name}"?\n\nIt is PUBLISHED — Prod Specs that link it will keep a stale output entry (skipped with a warning at run time) until the entry is removed there.`
        : `Delete draft "${row.name}"?`;
    if (!window.confirm(warning)) return;
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/output-layouts/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-8 py-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Output builder</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Build simple prints as configuration — corner-anchored text and barcodes with{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs">{"{{variables}}"}</code>. Published
            layouts appear in the Prod Spec output picker; they only generate once linked there.
          </p>
        </div>
        <button
          type="button"
          onClick={createLayout}
          disabled={busy !== null}
          className="rounded-md bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {busy === "new" ? "Creating…" : "New layout"}
        </button>
      </div>

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-zinc-200 bg-white px-5 py-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Logos</div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600">Contrast</span>
          {contrastLogoFound ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              found · {"{{logo:contrast}}"}
            </span>
          ) : (
            <span
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
              title="Commit the logo file to the repo — no code change needed"
            >
              add <code className="font-mono">public/logos/contrast.svg</code> to the repo
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-600">Custom</span>
          {customLogo ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={customLogo} alt="Custom logo" className="h-6 w-auto rounded border border-zinc-100" />
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                {"{{logo:custom}}"}
              </span>
              <button type="button" onClick={removeLogo} className="text-xs text-zinc-400 hover:text-red-600">
                Remove
              </button>
            </>
          ) : (
            <label className="cursor-pointer rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
              Upload (SVG/PNG/JPG)
              <input
                type="file"
                accept="image/svg+xml,image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        {logoError ? <span className="text-xs text-red-600">{logoError}</span> : null}
      </div>

      {layouts.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-zinc-300 bg-white px-8 py-16 text-center">
          <p className="text-sm font-medium text-zinc-700">No layouts yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Start with “New layout”, set the physical size, drop text into the corners and watch it render on a real
            style.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3 font-medium">Layout</th>
                <th className="px-4 py-3 font-medium">Pages</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Test data</th>
                <th className="px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {layouts.map((l) => (
                <tr key={l.id} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50/60">
                  <td className="px-4 py-3">
                    <Link href={`/output-builder/${l.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                      {l.name}
                    </Link>
                    <div className="mt-0.5 font-mono text-xs text-zinc-400">
                      layout:{l.id.slice(0, 10)}… · {l.docType}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.pageCount} · <span className="font-mono text-xs">{l.dims} mm</span>
                  </td>
                  <td className="px-4 py-3">
                    {l.status === "PUBLISHED" ? (
                      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Published · v{l.version}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-xs font-medium text-zinc-500">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.customerName ? (
                      <>
                        {l.customerName}
                        {l.businessAreaName ? <span className="text-zinc-400"> · {l.businessAreaName}</span> : null}
                      </>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-500">{new Date(l.updatedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => duplicateLayout(l.id)}
                        disabled={busy !== null}
                        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteLayout(l)}
                        disabled={busy !== null}
                        className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-400 hover:border-red-200 hover:text-red-600 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
