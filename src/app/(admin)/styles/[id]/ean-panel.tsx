"use client";

import { useState } from "react";
import type { EanView, EanDiagnostics } from "@/lib/po/ean-view";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import { colorFromVariantLabel } from "@/lib/po/ean-format";

type OverrideOp =
  | { op: "toggle"; id: string; excluded: boolean }
  | { op: "add"; size: string; ean13: string }
  | { op: "delete"; id: string };
import { ScrapePanel } from "./scrape-panel";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addSize, setAddSize] = useState("");
  const [addEan, setAddEan] = useState("");

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

  // Send an override op. Returns true on success so callers can clear inputs.
  async function override(op: OverrideOp): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/eans`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
      setView(body as EanView);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addRow() {
    if (!addSize.trim() || !addEan.trim()) return;
    if (await override({ op: "add", size: addSize.trim(), ean13: addEan.trim() })) {
      setAddSize("");
      setAddEan("");
    }
  }

  const meta = eanStatusMeta(view.status);
  const hasEans = view.sizeEans.length > 0;

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

      {hasEans || hasPo ? (
        <div className="mt-3">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="py-1 pr-3 font-medium" title="Untick to hide this EAN from all prints">
                  Show
                </th>
                <th className="py-1 pr-4 font-medium">Size</th>
                <th className="py-1 pr-4 font-medium">Color</th>
                <th className="py-1 pr-4 font-medium">EAN</th>
                <th className="py-1 pr-4 font-medium">PO label</th>
                <th className="py-1 font-medium sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.sizeEans.map((s) => (
                <tr
                  key={s.id}
                  className={`border-t border-zinc-100 ${s.excluded ? "opacity-45" : ""}`}
                >
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      checked={!s.excluded}
                      disabled={busy}
                      title={s.excluded ? "Hidden from prints — tick to show" : "Untick to hide from prints"}
                      onChange={() => override({ op: "toggle", id: s.id, excluded: !s.excluded })}
                      className="h-4 w-4 cursor-pointer accent-zinc-800 disabled:opacity-40"
                    />
                  </td>
                  <td className="py-1 pr-4 text-zinc-600">{s.size}</td>
                  <td className="py-1 pr-4 text-zinc-600">
                    {colorFromVariantLabel(s.variantLabel) || "—"}
                  </td>
                  <td
                    className={`py-1 pr-4 tabular-nums ${
                      s.ean13
                        ? `font-medium ${s.excluded ? "text-zinc-500 line-through" : "text-zinc-800"}`
                        : "text-zinc-300"
                    }`}
                  >
                    {s.ean13 ?? "— no match"}
                  </td>
                  <td className="py-1 pr-4 text-xs text-zinc-400">
                    {s.manual ? (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700">
                        manual
                      </span>
                    ) : (
                      (s.variantLabel ?? "—")
                    )}
                  </td>
                  <td className="py-1 text-right">
                    {s.manual && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => override({ op: "delete", id: s.id })}
                        title="Delete this manually-added EAN"
                        className="rounded px-1.5 text-xs text-red-500 hover:bg-red-50 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {/* Add a missing EAN by hand — persists and survives re-resolve. */}
              <tr className="border-t border-zinc-100">
                <td className="py-1 pr-3 text-center text-zinc-300">+</td>
                <td className="py-1 pr-4">
                  <input
                    value={addSize}
                    onChange={(e) => setAddSize(e.target.value)}
                    placeholder="Size"
                    disabled={busy}
                    className="w-16 rounded border border-zinc-300 px-1.5 py-0.5 text-sm"
                  />
                </td>
                <td className="py-1 pr-4" />
                <td className="py-1 pr-4">
                  <input
                    value={addEan}
                    onChange={(e) => setAddEan(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addRow();
                    }}
                    placeholder="13-digit EAN"
                    inputMode="numeric"
                    maxLength={13}
                    disabled={busy}
                    className="w-40 rounded border border-zinc-300 px-1.5 py-0.5 text-sm tabular-nums"
                  />
                </td>
                <td className="py-1 pr-4" />
                <td className="py-1 text-right">
                  <button
                    type="button"
                    disabled={busy || !addSize.trim() || addEan.length !== 13}
                    onClick={addRow}
                    className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                  >
                    Add
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          {view.cartonEan && (
            <div className="mt-2 text-xs tabular-nums text-zinc-500">
              carton <span className="font-medium text-zinc-800">{view.cartonEan}</span>
            </div>
          )}
          <p className="mt-2 text-xs text-zinc-400">
            Untick an EAN to hide it from all prints; add a row for a missing one. Both survive
            re-resolve.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">
          {view.message
            ? view.message
            : "No PO number on this style yet."}
        </p>
      )}

      {view.diagnostics?.poSections && view.diagnostics.poSections.length > 0 && (
        <ScrapePanel sections={view.diagnostics.poSections} />
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
        <Row
          k="Colour scope"
          v={
            d.colourScopeApplied
              ? `${d.colourLetters.map((l) => `*${l}`).join(", ")} — ${d.variantsExcludedByColour} other-colour row${d.variantsExcludedByColour === 1 ? "" : "s"} excluded`
              : (d.colourCodeOnStyle ?? "—")
          }
        />
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
