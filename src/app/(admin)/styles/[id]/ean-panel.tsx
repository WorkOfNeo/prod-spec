"use client";

import { useState } from "react";
import type { EanView, EanDiagnostics } from "@/lib/po/ean-view";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import { colorFromVariantLabel } from "@/lib/po/ean-format";

// Details-tab EAN panel. Shows the persisted PO → EAN resolution (per-size
// rows + carton) when present; when no EANs are resolved yet it surfaces a
// "Resolve" button that scrapes the PO PDF on the spot (and persists, so a
// reload keeps the result). Re-resolve is always available once a PO exists.
export function EanPanel({
  styleId,
  hasPo,
  initial,
}: {
  styleId: string;
  hasPo: boolean;
  initial: EanView;
}) {
  const [view, setView] = useState<EanView>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/eans`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView((await res.json()) as EanView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  const meta = eanStatusMeta(view.status);
  const hasEans = view.sizeEans.some((s) => s.ean13);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
            {meta.label}
          </span>
          {view.poFileName && <span className="text-xs text-zinc-400">{view.poFileName}</span>}
        </div>
        {hasPo ? (
          <button
            type="button"
            onClick={resolve}
            disabled={loading}
            className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
          >
            {loading ? "Resolving…" : hasEans ? "Re-resolve" : "Resolve"}
          </button>
        ) : (
          <span className="text-xs text-zinc-400">Add a PO number to resolve EANs</span>
        )}
      </div>

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

      {hasEans ? (
        <div className="mt-3">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="py-1 pr-4 font-medium">Size</th>
                <th className="py-1 pr-4 font-medium">Color</th>
                <th className="py-1 pr-4 font-medium">EAN</th>
                <th className="py-1 font-medium">PO label</th>
              </tr>
            </thead>
            <tbody>
              {view.sizeEans.map((s, i) => (
                <tr key={i} className="border-t border-zinc-100">
                  <td className="py-1 pr-4 text-zinc-600">{s.size}</td>
                  <td className="py-1 pr-4 text-zinc-600">{colorFromVariantLabel(s.variantLabel) || "—"}</td>
                  <td
                    className={`py-1 pr-4 tabular-nums ${
                      s.ean13 ? "font-medium text-zinc-800" : "text-zinc-300"
                    }`}
                  >
                    {s.ean13 ?? "— no match"}
                  </td>
                  <td className="py-1 text-xs text-zinc-400">{s.variantLabel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.cartonEan && (
            <div className="mt-2 text-xs tabular-nums text-zinc-500">
              carton <span className="font-medium text-zinc-800">{view.cartonEan}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          {view.message
            ? view.message
            : hasPo
              ? "No EANs resolved yet — click Resolve to scrape the PO PDF for the per-size barcodes."
              : "No PO number on this style yet."}
        </p>
      )}

      {view.diagnostics && <Diagnostics d={view.diagnostics} />}
    </div>
  );
}

// Verification panel: did we read the right file, and did it contain
// barcodes at all? Renders after a live resolve (diagnostics aren't
// persisted, so it's empty until the Resolve button is clicked).
function Diagnostics({ d }: { d: EanDiagnostics }) {
  return (
    <details className="mt-3 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
      <summary className="cursor-pointer select-none font-medium text-zinc-700">
        Diagnostics — which file was read &amp; what was in it
      </summary>
      {(d.poFileWebUrl || d.supplierFolderUrl) && (
        <div className="mt-2 flex flex-wrap gap-4">
          {d.poFileWebUrl && (
            <a
              href={d.poFileWebUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline"
            >
              Open PO PDF in SharePoint ↗
            </a>
          )}
          {d.supplierFolderUrl && (
            <a
              href={d.supplierFolderUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline"
            >
              Open supplier folder ↗
            </a>
          )}
        </div>
      )}
      <dl className="mt-2 grid grid-cols-1 gap-y-1 sm:grid-cols-2 sm:gap-x-6">
        <Row k="Chosen file" v={d.poFileName ?? "—"} />
        <Row k="Matching PDFs" v={String(d.candidateCount)} />
        <Row k="Barcode page found" v={d.barcodePageFound ? "yes" : "no"} />
        <Row k="13-digit tokens in PDF" v={String(d.ean13TokensInFullText)} />
        <Row k="Parsed items / variants" v={`${d.parsedItemCount} / ${d.parsedVariantCount}`} />
        <Row k="PDF pages / text length" v={`${d.pdfPageCount} / ${d.pdfTextLength}`} />
        <Row k="Queries tried" v={d.queriesTried.join(", ") || "—"} />
        <Row k="Customer Item No (style)" v={d.customerItemNoOnStyle ?? "—"} />
      </dl>

      {d.candidates.length > 1 && (
        <div className="mt-2">
          <div className="font-medium text-zinc-700">All matching PDFs (best first)</div>
          <ul className="mt-1 space-y-0.5">
            {d.candidates.map((c, i) => (
              <li key={i} className="flex justify-between gap-3">
                {c.webUrl ? (
                  <a
                    href={c.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`underline ${i === 0 ? "font-medium text-blue-700" : "text-blue-600"}`}
                  >
                    {c.name}
                  </a>
                ) : (
                  <span className={i === 0 ? "font-medium text-zinc-800" : ""}>{c.name}</span>
                )}
                <span className="tabular-nums text-zinc-400">{c.score}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.textSnippet && (
        <div className="mt-2">
          <div className="font-medium text-zinc-700">PDF text snippet</div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] leading-snug text-zinc-600">
            {d.textSnippet}
          </pre>
        </div>
      )}
    </details>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-right font-medium text-zinc-800">{v}</dd>
    </div>
  );
}
