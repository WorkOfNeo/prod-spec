"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// In-review info-area size picker — the review screen is where reviewers
// actually operate (they rarely open the style page), so the print-size
// choice lives on the output card here too. Same PATCH endpoint as the
// style page's picker; the difference is follow-through: after saving,
// this immediately re-runs the output so the reviewer sees the proof at
// the new size (including the "barcode won't scan at this size" chip when
// the chosen size can't hold a compliant EAN — that feedback is the point
// of picking the size here).
//
// The pick lives on ProdSpec.outputs[] — shared by every style under this
// spec — mirroring the style page's picker exactly.

export type InfoAreaSizeOption = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
};

function fmtMm(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

function parseMm(s: string): number {
  return Number(s.replace(",", "."));
}

export function ReviewInfoAreaSizePicker({
  styleId,
  prodSpecId,
  variantKey,
  sizes,
  currentSizeId,
  currentSizeName,
  widthMm,
  heightMm,
  ready,
}: {
  styleId: string;
  prodSpecId: string;
  variantKey: string; // base key — the ProdSpec output entry's key
  sizes: InfoAreaSizeOption[];
  currentSizeId: string | null;
  currentSizeName: string | null;
  widthMm: number;
  heightMm: number;
  // Output can regenerate (no missing required fields). When false the size
  // still saves; the re-run is skipped and the hint says so.
  ready: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "saving" | "rendering">(null);
  const [err, setErr] = useState<string | null>(null);
  const [pendingCustom, setPendingCustom] = useState(false);
  const [customW, setCustomW] = useState(fmtMm(widthMm));
  const [customH, setCustomH] = useState(fmtMm(heightMm));

  const showCustom = pendingCustom || currentSizeId === null;
  const selectValue = showCustom ? "custom" : `size:${currentSizeId}`;
  // The pick may reference a now-deactivated size — keep it selectable with
  // a labelled synthetic option (same rule as the style page's picker).
  const currentMissing = currentSizeId !== null && !sizes.some((s) => s.id === currentSizeId);

  async function applyAndRerun(body: {
    infoAreaSizeId: string | null;
    widthMm?: number;
    heightMm?: number;
  }) {
    setErr(null);
    setBusy("saving");
    try {
      const res = await fetch(`/api/admin/prod-specs/${prodSpecId}/output-info-area-size`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (ready) {
        // Regenerate this one output at the new size so the proof above
        // updates in place — same endpoint as "Re-run this output".
        setBusy("rendering");
        const run = await fetch(`/api/admin/styles/${styleId}/rerun`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantKeys: [variantKey] }),
        });
        if (!run.ok) {
          const runData = await run.json().catch(() => ({}));
          setErr(
            `Size saved, but the re-run failed: ${runData.error ?? `HTTP ${run.status}`}. Use "Re-run this output" below.`,
          );
          return;
        }
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  function onSelect(value: string) {
    if (value === "custom") {
      setPendingCustom(true);
      setCustomW(fmtMm(widthMm));
      setCustomH(fmtMm(heightMm));
      return;
    }
    setPendingCustom(false);
    void applyAndRerun({ infoAreaSizeId: value.slice("size:".length) });
  }

  const cw = parseMm(customW);
  const ch = parseMm(customH);
  const customValid =
    Number.isFinite(cw) && cw > 0 && cw <= 1000 && Number.isFinite(ch) && ch > 0 && ch <= 1000;
  const customDirty = cw !== widthMm || ch !== heightMm;

  return (
    <div className="border-t border-zinc-100 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-zinc-500">Print size</span>
        <select
          value={selectValue}
          disabled={busy !== null}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 disabled:opacity-50"
        >
          {sizes.map((s) => (
            <option key={s.id} value={`size:${s.id}`}>
              {s.name} · {fmtMm(s.widthMm)} × {fmtMm(s.heightMm)} mm
            </option>
          ))}
          {currentMissing && (
            <option value={`size:${currentSizeId}`}>
              {(currentSizeName ?? "Selected size") + " (disabled)"}
            </option>
          )}
          <option value="custom">Custom…</option>
        </select>
        {showCustom && (
          <span className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={customW}
              disabled={busy !== null}
              onChange={(e) => setCustomW(e.target.value)}
              className="w-14 rounded-md border border-zinc-300 px-1.5 py-1 text-xs tabular-nums"
              aria-label="Custom width (mm)"
            />
            <span className="text-[10px] text-zinc-400">×</span>
            <input
              type="text"
              inputMode="decimal"
              value={customH}
              disabled={busy !== null}
              onChange={(e) => setCustomH(e.target.value)}
              className="w-14 rounded-md border border-zinc-300 px-1.5 py-1 text-xs tabular-nums"
              aria-label="Custom height (mm)"
            />
            <span className="text-[10px] text-zinc-400">mm</span>
            <button
              type="button"
              disabled={busy !== null || !customValid || (!customDirty && currentSizeId === null)}
              onClick={() => void applyAndRerun({ infoAreaSizeId: null, widthMm: cw, heightMm: ch })}
              className="rounded-md bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Apply
            </button>
          </span>
        )}
        {busy ? (
          <span className="text-[11px] text-zinc-400">
            {busy === "saving" ? "Saving…" : "Regenerating at the new size…"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[10px] text-zinc-400">
        {ready
          ? "Picking a size regenerates this output so the proof above shows it."
          : "Saves the size — this output can't regenerate until its missing fields are filled."}
      </p>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}
