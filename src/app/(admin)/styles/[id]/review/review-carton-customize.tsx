"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LazyOutputPreview } from "@/components/output-preview";

// In-review "Customize" — the carton-finishing step done WHERE the reviewer
// already is. Unlike the style-page download dialog, this REGENERATES the one
// carton output and REPLACES it, so the customized result re-enters review.
// Two MUTUALLY-EXCLUSIVE modes (pick one):
//   • Carton numbering — one multi-page PDF, 1/N … N/N (the whole printed set
//     is reviewable in this card).
//   • Multiple styles  — other same-PO styles on the box ({{style2}}…).
// On generate it POSTs /carton-customize and refreshes — the card then shows
// the new asset as pending review. Available to reviewers AND admins.
const CARTON_MAX = 2000;

type SiblingCandidate = {
  id: string;
  styleNumber: string;
  styleName: string;
  colourName: string;
  description: string;
};

export type ReviewCartonCustomizeProps = {
  styleId: string;
  // Base variant key (no "#suffix") — the output slot to regenerate.
  variantKey: string;
  name: string;
  widthMm: number;
  heightMm: number;
  // Which capabilities this layout opted into (independent).
  cartonNumbering: boolean;
  multipleStyles: boolean;
};

export function ReviewCartonCustomize(props: ReviewCartonCustomizeProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Customize this carton output and regenerate it for review"
        className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        Customize
      </button>
      {open ? <CartonCustomizeDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CartonCustomizeDialog({
  styleId,
  variantKey,
  name,
  widthMm,
  heightMm,
  cartonNumbering,
  multipleStyles,
  onClose,
}: ReviewCartonCustomizeProps & { onClose: () => void }) {
  const router = useRouter();
  // The two capabilities can't combine here — when the layout has BOTH, the
  // operator switches between them; with one, that mode shows directly.
  const both = cartonNumbering && multipleStyles;
  const [mode, setMode] = useState<"numbering" | "multi">(
    cartonNumbering ? "numbering" : "multi",
  );
  const numbering = mode === "numbering";
  const multi = mode === "multi";

  const [total, setTotal] = useState(200);
  const [debouncedTotal, setDebouncedTotal] = useState(total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same-PO siblings to place on the box (one-off).
  const [siblings, setSiblings] = useState<SiblingCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [siblingsLoaded, setSiblingsLoaded] = useState(!multipleStyles);

  // Debounce the preview so typing the count doesn't refetch per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedTotal(total), 350);
    return () => window.clearTimeout(t);
  }, [total]);

  // Load the same-PO sibling candidates up front (ready the moment the operator
  // switches to Multiple styles) — only when the layout supports it.
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
        // Non-fatal — multi-style just has nothing to pick.
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

  function toggleSibling(sid: string) {
    setSelectedIds((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid]));
  }

  const countValid = !numbering || (Number.isInteger(total) && total >= 1 && total <= CARTON_MAX);
  const canGenerate = numbering ? countValid : selectedIds.length > 0;
  const previewNo = Math.min(7, Math.max(1, debouncedTotal));

  const previewSrc =
    `/api/admin/styles/${styleId}/output-preview?variantKey=${encodeURIComponent(variantKey)}` +
    (numbering ? `&cartonNo=${previewNo}&cartonTotal=${Math.max(1, debouncedTotal)}` : "") +
    (multi ? `&siblingIds=${selectedIds.join(",")}` : "");

  async function generate() {
    if (!canGenerate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/styles/${styleId}/carton-customize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          numbering
            ? { variantKey, total }
            : { variantKey, total: 1, siblingIds: selectedIds },
        ),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Generation failed (${res.status})`);
      // Replaced in place — refresh so the card shows the new pending asset.
      onClose();
      router.refresh();
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
          <h2 className="text-[15px] font-semibold text-zinc-900">Customize &amp; regenerate</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{name}</p>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {/* Mode picker — only when the layout supports BOTH (mutually exclusive). */}
          {both && (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Customization
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
                  <input
                    type="radio"
                    name="carton-customize-mode"
                    checked={numbering}
                    onChange={() => setMode("numbering")}
                    className="accent-amber-600"
                  />
                  Carton numbering (X of Y)
                </label>
                <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
                  <input
                    type="radio"
                    name="carton-customize-mode"
                    checked={multi}
                    onChange={() => setMode("multi")}
                    className="accent-indigo-600"
                  />
                  Multiple styles
                </label>
              </div>
            </div>
          )}

          {/* Carton numbering — X of Y. */}
          {numbering && (
            <div className={both ? "border-t border-zinc-100 pt-3" : ""}>
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
                    1/{countValid ? total : "…"} → {countValid ? total : "…"}/
                    {countValid ? total : "…"}
                  </span>
                  <br />
                  one page per carton, in one PDF
                </div>
              </div>
              {!countValid ? (
                <p className="mt-1 text-[11px] text-red-600">
                  Enter a whole number between 1 and {CARTON_MAX}.
                </p>
              ) : null}
            </div>
          )}

          {/* Multiple styles — other styles from the same PO. */}
          {multi && (
            <div className={both ? "border-t border-zinc-100 pt-3" : ""}>
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
                            ? "border-indigo-300 bg-indigo-50"
                            : "border-zinc-200 bg-white hover:bg-zinc-50"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[9px] font-bold ${
                            checked
                              ? "border-indigo-500 bg-indigo-500 text-white"
                              : "border-zinc-300 bg-white text-transparent"
                          }`}
                        >
                          ✓
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-semibold text-zinc-800">
                            {s.styleNumber || s.styleName || s.id}
                          </span>
                          {s.colourName ? (
                            <span className="text-zinc-500"> · {s.colourName}</span>
                          ) : null}
                          {s.styleName && s.styleNumber ? (
                            <span className="text-zinc-400"> · {s.styleName}</span>
                          ) : null}
                        </span>
                        {checked && (
                          <span className="flex-shrink-0 rounded bg-indigo-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-800">
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
              {numbering
                ? `Live preview — carton ${previewNo} of ${Math.max(1, debouncedTotal)}`
                : "Live preview"}
            </div>
            <div className="mx-auto" style={{ maxWidth: Math.max(widthMm * 3.4, 220) }}>
              <LazyOutputPreview
                src={previewSrc}
                widthMm={widthMm}
                heightMm={heightMm}
                refreshKey={`${numbering ? previewNo : "x"}-${debouncedTotal}-${
                  multi ? selectedIds.join(",") : "x"
                }`}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            {numbering ? (
              <>
                Replaces this output with one print-ready PDF, {countValid ? total : "N"} page
                {countValid && total === 1 ? "" : "s"} — each numbered with{" "}
                <code className="rounded bg-zinc-100 px-1">{"{{cartonNo}}"}</code>/
                <code className="rounded bg-zinc-100 px-1">{"{{cartonTotal}}"}</code>.{" "}
              </>
            ) : (
              <>Replaces this output with one print-ready page carrying the selected styles. </>
            )}
            It re-enters review as pending so you can check it before it ships.
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
            disabled={!canGenerate || busy}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Regenerating…" : "Regenerate for review"}
          </button>
        </div>
      </div>
    </div>
  );
}
