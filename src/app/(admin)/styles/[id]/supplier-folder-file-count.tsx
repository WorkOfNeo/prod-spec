"use client";

import { useEffect, useState } from "react";

// Live "how many files are in the PO folder" badge for the Supplier folder
// panel. Fetches the count lazily (a Graph round-trip) so it never blocks the
// server render of the style page. Shows just the number; the surrounding
// panel already explains WHERE the folder is and its delivery state.
type Folder = { name: string; webUrl: string | null; fileCount: number };
type Resp = { status: string; poNumber: string | null; folders: Folder[]; error?: string };

export function SupplierFolderFileCount({ styleId }: { styleId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/styles/${styleId}/supplier-folder-files`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as Resp;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then((j) => {
        if (alive) {
          setData(j);
          setErr(null);
        }
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "lookup failed");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [styleId]);

  if (loading) return <span className="text-xs text-zinc-400">Counting files…</span>;
  if (err)
    return (
      <span className="text-xs text-zinc-400" title={err}>
        Files: —
      </span>
    );
  if (!data) return null;

  if (data.status === "found" && data.folders[0]) {
    const f = data.folders[0];
    const n = f.fileCount;
    const empty = n === 0;
    const body = (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
          empty
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}
      >
        📁 {n} file{n === 1 ? "" : "s"}
        {empty ? " — folder empty" : " in folder"}
      </span>
    );
    return f.webUrl ? (
      <a href={f.webUrl} target="_blank" rel="noopener noreferrer" title={`Open “${f.name}”`}>
        {body}
      </a>
    ) : (
      body
    );
  }

  if (data.status === "ambiguous") {
    const total = data.folders.reduce((s, f) => s + f.fileCount, 0);
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-200 bg-fuchsia-50 px-2.5 py-0.5 text-xs font-semibold text-fuchsia-800"
        title={data.folders.map((f) => `${f.name}: ${f.fileCount} file(s)`).join(" · ")}
      >
        📁 {total} files · {data.folders.length} folders
      </span>
    );
  }

  if (data.status === "missing") {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        No PO folder found
      </span>
    );
  }

  // no-supplier / no-link / no-po / not-configured → nothing to add here; the
  // panel's resolution chain already states why there's no folder to count.
  return null;
}
