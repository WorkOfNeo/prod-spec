"use client";

import { useEffect, useState } from "react";
import { LazyOutputPreview } from "@/components/output-preview";

// MANUAL carton prints — a side action next to the per-output "Run". Standard
// generation is untouched (always single-style). Two INDEPENDENT capabilities,
// each a layout setting, drive this dialog:
//   • Carton numbering — print a numbered set (1/N … N/N), {{cartonNo}}.
//   • Multiple styles  — "Custom Carton Marking": place OTHER styles from the
//     SAME PO on the box ({{style2}}/{{style3}}…). A one-off for this print
//     only — there is no standing config. The endpoint streams back ONE
//     PDF (one page per carton) to download.
const CARTON_MAX = 2000;

type SiblingCandidate = {
  id: string;
  styleNumber: string;
  styleName: string;
  colourName: string;
  description: string;
};

export type CartonPrintsButtonProps = {
  styleId: string;
  variantKey: string;
  name: string;
  ready: boolean;
  widthMm: number;
  heightMm: number;
  // Which capabilities this layout opted into (independent).
  cartonNumbering: boolean;
  multipleStyles: boolean;
};

export function CartonPrintsButton(props: CartonPrintsButtonProps) {
  const [open, setOpen] = useState(false);
  const title = props.cartonNumbering && props.multipleStyles
    ? "Print a numbered carton set (X of Y) and/or place other styles from this PO on the box"
    : props.cartonNumbering
      ? "Print a numbered carton set (X of Y)"
      : "Place other styles from this PO on the box";
  return (
    <>
      <button
        type="button"
        disabled={!props.ready}
        onClick={() => setOpen(true)}
        title={props.ready ? title : "Output not ready yet"}
        className="flex-shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Carton marking…
      </button>
      {open ? <CartonPrintsDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CartonPrintsDialog({
  styleId,
  variantKey,
  name,
  widthMm,
  heightMm,
  cartonNumbering,
  multipleStyles,
  onClose,
}: CartonPrintsButtonProps & { onClose: () => void }) {
  const [total, setTotal] = useState(cartonNumbering ? 200 : 1);
  const [debouncedTotal, setDebouncedTotal] = useState(total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom Carton Marking — same-PO siblings to place on the box (one-off).
  const [siblings, setSiblings] = useState<SiblingCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Starts "loaded" when this layout can't do multi-style (the section is
  // hidden anyway) so the fetch effect never has to setState synchronously.
  const [siblingsLoaded, setSiblingsLoaded] = useState(!multipleStyles);

  // Debounce the preview so typing the count doesn't refetch per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedTotal(total), 350);
    return () => window.clearTimeout(t);
  }, [total]);

  // Load the same-PO sibling candidates — only when this layout supports it.
  useEffect(() => {
    if (!multipleStyles) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/styles/${styleId}/po-siblings`);
        if (!res.ok) throw new Error();
        const j = (await res.json()) as { siblings?: SiblingCandidate[] };
        if (!cancelled) setSiblings(j.siblings ?? []);
      } catch {
        // Non-fatal — the dialog still does plain X-of-Y without siblings.
      } finally {
        if (!cancelled) setSiblingsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [styleId, multipleStyles]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleSibling(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Count only matters for carton numbering; a multi-style-only print is one
  // page. total is fixed to 1 when numbering is off.
  const countValid =
    !cartonNumbering || (Number.isInteger(total) && total >= 1 && total <= CARTON_MAX);
  const effectiveTotal = cartonNumbering ? total : 1;
  const previewNo = Math.min(7, Math.max(1, debouncedTotal));

  const previewSrc =
    `/api/admin/styles/${styleId}/output-preview?variantKey=${encodeURIComponent(variantKey)}` +
    (cartonNumbering ? `&cartonNo=${previewNo}&cartonTotal=${Math.max(1, debouncedTotal)}` : "") +
    // Present (even empty) ⇒ multi-style mode ON, {{multipleStyles}} = true.
    (multipleStyles ? `&siblingIds=${selectedIds.join(",")}` : "");

  async function generate() {
    if (!countValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/carton-prints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantKey,
          total: effectiveTotal,
          ...(multipleStyles ? { siblingIds: selectedIds } : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Generation failed (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^"]+)"?/.exec(cd);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m?.[1] ?? `carton-${effectiveTotal}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedSet = new Set(selectedIds);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-zinc-900">Carton marking prints</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{name}</p>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {/* Carton numbering — X of Y. */}
          {cartonNumbering && (
            <div>
              <label className="text-xs font-medium text-zinc-700">How many cartons?</label>
              <div className="mt-1.5 flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={CARTON_MAX}
                  value={total}
                  autoFocus
                  onChange={(e) => setTotal(Math.floor(Number(e.target.value) || 0))}
                  className="w-24 rounded-lg border border-zinc-300 px-3 py-2 text-center text-lg font-semibold tabular-nums text-zinc-900 focus:border-zinc-400 focus:outline-none"
                />
                <div className="text-xs text-zinc-500">
                  prints{" "}
                  <span className="font-semibold text-zinc-700">
                    1/{countValid ? total : "…"} → {countValid ? total : "…"}/{countValid ? total : "…"}
                  </span>
                  <br />
                  one page per carton
                </div>
              </div>
              {!countValid ? (
                <p className="mt-1 text-[11px] text-red-600">
                  Enter a whole number between 1 and {CARTON_MAX}.
                </p>
              ) : null}
            </div>
          )}

          {/* Custom Carton Marking — other styles from the same PO. */}
          {multipleStyles && (
            <div className={cartonNumbering ? "border-t border-zinc-100 pt-3" : ""}>
              <div className="flex items-baseline justify-between">
                <label className="text-xs font-medium text-zinc-700">
                  Other styles on the box{" "}
                  <span className="font-normal text-zinc-400">(same PO)</span>
                </label>
                {selectedIds.length > 0 && (
                  <span className="text-[11px] tabular-nums text-zinc-500">
                    {selectedIds.length + 1} styles
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
                Tick to fill the{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{style2}}"}</code>,{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{style3}}"}</code>… slots. Order = slot
                order.
              </p>
              <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
                {!siblingsLoaded ? (
                  <p className="text-[11px] text-zinc-400">Loading…</p>
                ) : siblings.length === 0 ? (
                  <p className="text-[11px] text-zinc-400">No other styles on this PO.</p>
                ) : (
                  siblings.map((s) => {
                    const slot = selectedIds.indexOf(s.id);
                    const checked = selectedSet.has(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleSibling(s.id)}
                        className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition ${
                          checked
                            ? "border-amber-300 bg-amber-50"
                            : "border-zinc-200 bg-white hover:bg-zinc-50"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[9px] font-bold ${
                            checked
                              ? "border-amber-500 bg-amber-500 text-white"
                              : "border-zinc-300 bg-white text-transparent"
                          }`}
                        >
                          ✓
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-semibold text-zinc-800">
                            {s.styleNumber || s.styleName || s.id}
                          </span>
                          {s.colourName ? <span className="text-zinc-500"> · {s.colourName}</span> : null}
                          {s.styleName && s.styleNumber ? (
                            <span className="text-zinc-400"> · {s.styleName}</span>
                          ) : null}
                        </span>
                        {checked && (
                          <span className="flex-shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-800">
                            {`{{style${slot + 2}}}`}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              {cartonNumbering
                ? `Live preview — carton ${previewNo} of ${Math.max(1, debouncedTotal)}`
                : "Live preview"}
            </div>
            <div className="mx-auto" style={{ maxWidth: Math.max(widthMm * 3.4, 220) }}>
              <LazyOutputPreview
                src={previewSrc}
                widthMm={widthMm}
                heightMm={heightMm}
                refreshKey={`${previewNo}-${debouncedTotal}-${selectedIds.join(",")}`}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            {cartonNumbering ? (
              <>
                One print-ready PDF, {countValid ? total : "N"} pages — each numbered with{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{cartonNo}}"}</code>/
                <code className="rounded bg-zinc-100 px-1">{"{{cartonTotal}}"}</code>.{" "}
              </>
            ) : (
              <>One print-ready page with the selected styles on the box. </>
            )}
            The standard output is unaffected.
          </p>

          {error ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={generate}
            disabled={!countValid || busy}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate & download"}
          </button>
        </div>
      </div>
    </div>
  );
}
