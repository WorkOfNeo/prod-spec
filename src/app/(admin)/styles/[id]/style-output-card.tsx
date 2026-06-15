"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LazyOutputPreview } from "@/components/output-preview";
import { OutputThumbnail } from "./output-thumbnail";
import { RunOutputButton } from "./run-output-button";
import { CartonPrintsButton } from "./carton-prints-dialog";

export type InfoAreaSizeOption = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
};

// One output of one style, as a fold-out row. Collapsed it shows just the
// ready dot + name + a missing-fields hint, with the per-output Run button
// alongside, so a style with many outputs stays scannable. Folded out it
// reveals the LIVE preview rendered from the style's current data (same
// assembly as the real render — see /api/admin/styles/[id]/output-preview),
// the missing-field / pin / data-note chips, and the LAST GENERATED artifact.
// The live preview only fetches once the row is open, so the page doesn't
// render every output up front.
export type StyleOutputCardProps = {
  styleId: string;
  variantKey: string;
  name: string;
  ready: boolean;
  missing: string[];
  widthMm: number;
  heightMm: number;
  // Pinned fields on this output ("Customer name = Netto A/S").
  pins: Array<{ label: string; value: string }>;
  // Data notes, e.g. "No delivery term on row — defaulting to DDP".
  notes: string[];
  thumbSrc: string | null;
  pdfHref: string | null;
  generatedAt: string | null;
  // Layout opted into manual "X of Y" carton-numbered prints — shows the
  // badge + the "Carton numbers…" action alongside Run.
  cartonNumbering: boolean;
  // Info-area sizing: when isInfoArea, the output's print size is switchable
  // here (admin size or one-time custom). The pick is stored on the
  // ProdSpec output, so prodSpecId is needed to PATCH it.
  isInfoArea: boolean;
  prodSpecId: string | null;
  infoAreaSizeId: string | null;
  // Resolved name of the current pick (resolved server-side against ALL
  // sizes, so a deactivated pick still reads its name). null = custom.
  infoAreaSizeName: string | null;
  // Active admin sizes offered in the dropdown.
  infoAreaSizes: InfoAreaSizeOption[];
};

export function StyleOutputCard(p: StyleOutputCardProps) {
  const [open, setOpen] = useState(false);
  const hasChips = p.missing.length > 0 || p.pins.length > 0 || p.notes.length > 0;
  const showSizeControl = p.isInfoArea && p.prodSpecId !== null;
  // A label for the header dims readout: "<size name> · W × H mm".
  const sizeLabel = p.isInfoArea ? (p.infoAreaSizeName ?? "Custom") : null;
  // Re-fetch the live preview whenever the resolved size changes.
  const previewKey = `${p.infoAreaSizeId ?? "custom"}-${p.widthMm}x${p.heightMm}`;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      {/* Header — the toggle and the Run button are siblings (not nested
          buttons), so running an output never toggles the row. */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronIcon open={open} />
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
              p.ready ? "bg-emerald-500" : "bg-zinc-300"
            }`}
          />
          <span className="truncate text-sm font-semibold text-zinc-900" title={p.name}>
            {p.name}
          </span>
          {p.cartonNumbering && (
            <span
              title="This output can be printed as a numbered carton set (X of Y)"
              className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700"
            >
              Carton X/Y
            </span>
          )}
          {!open && p.missing.length > 0 && (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              {p.missing.length} missing
            </span>
          )}
        </button>
        <span className="hidden flex-shrink-0 text-[11px] tabular-nums text-zinc-400 sm:inline">
          {sizeLabel ? `${sizeLabel} · ` : ""}
          {p.widthMm} × {p.heightMm} mm
        </span>
        {p.cartonNumbering && (
          <CartonPrintsButton
            styleId={p.styleId}
            variantKey={p.variantKey}
            name={p.name}
            ready={p.ready}
            widthMm={p.widthMm}
            heightMm={p.heightMm}
          />
        )}
        <RunOutputButton
          styleId={p.styleId}
          variantKey={p.variantKey}
          ready={p.ready}
          missingLabels={p.missing}
        />
      </div>

      {open && (
        <div className="border-t border-zinc-100">
          {hasChips && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {p.missing.map((label) => (
                <span
                  key={`m-${label}`}
                  className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                >
                  missing: {label}
                </span>
              ))}
              {p.pins.map((pin) => (
                <span
                  key={`p-${pin.label}`}
                  title={`Pinned in the ProdSpec editor — always "${pin.value}"`}
                  className="rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700"
                >
                  📌 {pin.label} = {pin.value}
                </span>
              ))}
              {p.notes.map((note) => (
                <span
                  key={`n-${note}`}
                  className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800"
                >
                  {note}
                </span>
              ))}
            </div>
          )}

          {showSizeControl && (
            <div className="border-b border-zinc-100 px-4 py-3">
              <InfoAreaSizeControl
                prodSpecId={p.prodSpecId!}
                variantKey={p.variantKey}
                sizes={p.infoAreaSizes}
                currentSizeId={p.infoAreaSizeId}
                currentSizeName={p.infoAreaSizeName}
                widthMm={p.widthMm}
                heightMm={p.heightMm}
              />
            </div>
          )}

          <div className="bg-zinc-100 p-4">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              Live preview · current data
            </div>
            <LazyOutputPreview
              src={`/api/admin/styles/${p.styleId}/output-preview?variantKey=${encodeURIComponent(p.variantKey)}`}
              widthMm={p.widthMm}
              heightMm={p.heightMm}
              refreshKey={previewKey}
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <OutputThumbnail
                thumbSrc={p.thumbSrc}
                href={p.pdfHref}
                name={p.name}
                generatedAt={p.generatedAt}
              />
              <div className="min-w-0 text-[11px] leading-tight text-zinc-500">
                <div className="font-medium uppercase tracking-wide text-zinc-400">Last generated</div>
                <div className="truncate">{p.generatedAt ?? "never"}</div>
              </div>
            </div>
            <span className="flex-shrink-0 text-[11px] tabular-nums text-zinc-400">
              {p.widthMm} × {p.heightMm} mm
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Per-style size switcher for an info-area output. A dropdown of the admin
// sizes plus "Custom…"; picking an admin size saves immediately, "Custom"
// reveals width/height inputs for a one-time size. The pick persists on the
// ProdSpec output (shared by every style under the spec) and a router
// refresh re-renders the card + live preview at the new dimensions.
function InfoAreaSizeControl({
  prodSpecId,
  variantKey,
  sizes,
  currentSizeId,
  currentSizeName,
  widthMm,
  heightMm,
}: {
  prodSpecId: string;
  variantKey: string;
  sizes: InfoAreaSizeOption[];
  currentSizeId: string | null;
  currentSizeName: string | null;
  widthMm: number;
  heightMm: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Local "editing a custom size" flag — true while the user is on the
  // Custom option before saving. Derived default: custom when no admin pick.
  const [pendingCustom, setPendingCustom] = useState(currentSizeId === null);
  const [customW, setCustomW] = useState(String(widthMm));
  const [customH, setCustomH] = useState(String(heightMm));

  const showCustom = pendingCustom || currentSizeId === null;
  const selectValue = showCustom ? "custom" : `size:${currentSizeId}`;
  // The current pick may reference a now-deactivated size (absent from the
  // active list) — keep it selectable with a labelled synthetic option.
  const currentMissing =
    currentSizeId !== null && !sizes.some((s) => s.id === currentSizeId);

  async function patch(body: {
    infoAreaSizeId: string | null;
    widthMm?: number;
    heightMm?: number;
  }) {
    setBusy(true);
    setErr(null);
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
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function onSelect(value: string) {
    if (value === "custom") {
      setPendingCustom(true);
      setCustomW(String(widthMm));
      setCustomH(String(heightMm));
      return;
    }
    setPendingCustom(false);
    void patch({ infoAreaSizeId: value.slice("size:".length) });
  }

  const cw = Number(customW);
  const ch = Number(customH);
  const customValid =
    Number.isInteger(cw) && cw > 0 && cw <= 1000 && Number.isInteger(ch) && ch > 0 && ch <= 1000;
  const customDirty = cw !== widthMm || ch !== heightMm;

  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
        Info area size
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select
          value={selectValue}
          disabled={busy}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
        >
          {sizes.map((s) => (
            <option key={s.id} value={`size:${s.id}`}>
              {s.name} · {s.widthMm} × {s.heightMm} mm
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
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={1000}
              value={customW}
              disabled={busy}
              onChange={(e) => setCustomW(e.target.value)}
              className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-sm tabular-nums"
              aria-label="Custom width (mm)"
            />
            <span className="text-xs text-zinc-400">×</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={customH}
              disabled={busy}
              onChange={(e) => setCustomH(e.target.value)}
              className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-sm tabular-nums"
              aria-label="Custom height (mm)"
            />
            <span className="text-xs text-zinc-400">mm</span>
            <button
              type="button"
              disabled={busy || !customValid || (!customDirty && currentSizeId === null)}
              onClick={() => void patch({ infoAreaSizeId: null, widthMm: cw, heightMm: ch })}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-500">
        Sets the printed size for this info-area output. Applies wherever this Prod Spec prints it.
      </p>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
