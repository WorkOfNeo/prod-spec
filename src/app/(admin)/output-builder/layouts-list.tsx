"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { docTypeLabel } from "@/lib/pdf/doc-types";

type LayoutRow = {
  id: string;
  name: string;
  docType: string;
  status: "DRAFT" | "PUBLISHED";
  version: number;
  pageCount: number;
  defInvalid: boolean;
  customerName: string | null;
  businessAreaName: string | null;
  updatedAt: string;
  // Usage joins (computed server-side): the Prod Specs that carry this
  // layout as an enabled output (+ their customer), and the styles
  // currently resolved to those specs. `styles` is capped — `styleCount`
  // is the exact total.
  prodSpecs: Array<{ id: string; name: string; customerName: string }>;
  styleCount: number;
  styles: Array<{ id: string; name: string }>;
};

// Hover popover dropping DOWN from its trigger cell. Pure CSS
// (group-hover + focus-within keeps it keyboard-reachable); needs every
// ancestor between trigger and table wrapper to stay overflow-visible.
function HoverPopover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <div className="group relative inline-block" tabIndex={0}>
      <span className="cursor-default underline decoration-dotted decoration-zinc-300 underline-offset-2">
        {trigger}
      </span>
      <div className="invisible absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {children}
      </div>
    </div>
  );
}

export function LayoutsList({
  layouts,
  contrastLogoFound,
  logoImageCount,
}: {
  layouts: LayoutRow[];
  contrastLogoFound: boolean;
  // Active rows in the LogoImage library ({{logo:custom}} renders the one
  // linked on each style; the card just points operators at the flow).
  logoImageCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Search across everything a row shows or links to: layout name/type,
  // test-data customer, the prod specs (+ their customers) using the
  // layout, and the (capped) style list — so "which layout prints style
  // X / customer Y" is findable from here.
  const q = query.trim().toLowerCase();
  const visibleLayouts = q
    ? layouts.filter((l) =>
        [
          l.name,
          l.docType,
          docTypeLabel(l.docType),
          l.customerName ?? "",
          l.businessAreaName ?? "",
          ...l.prodSpecs.flatMap((s) => [s.name, s.customerName]),
          ...l.styles.map((s) => s.name),
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : layouts;

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
          <span
            className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600"
            title="The logo is decided per style — link one on the style's edit page"
          >
            {"{{logo:custom}}"} = the logo linked on each style
          </span>
          <Link href="/settings/logos" className="text-xs text-zinc-500 underline hover:text-zinc-800">
            {logoImageCount === 1 ? "1 logo" : `${logoImageCount} logos`} in the library · manage
          </Link>
        </div>
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
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search layouts — name, customer, prod spec, style…"
            className="mt-6 w-full max-w-md rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
            spellCheck={false}
          />
          {visibleLayouts.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-300 bg-white px-8 py-12 text-center text-sm text-zinc-500">
              No layouts match “{query}”.
            </div>
          ) : (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="rounded-tl-lg bg-zinc-50 px-4 py-3 font-medium">Layout</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Type</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Pages</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Test data</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Prod specs</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Styles</th>
                <th className="bg-zinc-50 px-4 py-3 font-medium">Updated</th>
                <th className="rounded-tr-lg bg-zinc-50 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleLayouts.map((l) => (
                <tr key={l.id} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          l.status === "PUBLISHED" ? "bg-emerald-500" : "bg-zinc-300"
                        }`}
                        title={l.status === "PUBLISHED" ? `Published · v${l.version}` : "Draft"}
                      />
                      <Link href={`/output-builder/${l.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                        {l.name}
                      </Link>
                    </div>
                    <div className="ml-4 mt-0.5 font-mono text-xs text-zinc-400">
                      layout:{l.id.slice(0, 10)}…
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                      {docTypeLabel(l.docType)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.defInvalid ? <span className="text-amber-600">invalid</span> : l.pageCount}
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
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.prodSpecs.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <HoverPopover
                        trigger={`${l.prodSpecs.length} prod spec${l.prodSpecs.length === 1 ? "" : "s"}`}
                      >
                        <ul className="space-y-1.5 text-xs">
                          {l.prodSpecs.map((s) => (
                            <li key={s.id}>
                              <Link href={`/prod-specs/${s.id}`} className="font-medium text-zinc-800 hover:underline">
                                {s.name}
                              </Link>
                              <div className="text-zinc-500">{s.customerName}</div>
                            </li>
                          ))}
                        </ul>
                      </HoverPopover>
                    )}
                    {l.prodSpecs.length > 0 ? (
                      <div className="mt-0.5 max-w-56 truncate text-xs text-zinc-400">
                        {[...new Set(l.prodSpecs.map((s) => s.customerName))].join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {l.styleCount === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <HoverPopover trigger={`${l.styleCount} style${l.styleCount === 1 ? "" : "s"}`}>
                        <ul className="space-y-1 text-xs">
                          {l.styles.map((s) => (
                            <li key={s.id}>
                              <Link href={`/styles/${s.id}`} className="text-zinc-700 hover:underline">
                                {s.name}
                              </Link>
                            </li>
                          ))}
                          {l.styleCount > l.styles.length ? (
                            <li className="pt-0.5 text-zinc-400">+{l.styleCount - l.styles.length} more</li>
                          ) : null}
                        </ul>
                      </HoverPopover>
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
        </>
      )}
    </div>
  );
}
