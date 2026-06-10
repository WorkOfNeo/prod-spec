"use client";

import { useState } from "react";
import { LazyOutputPreview } from "@/components/output-preview";
import { OutputThumbnail } from "./output-thumbnail";
import { RunOutputButton } from "./run-output-button";

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
};

export function StyleOutputCard(p: StyleOutputCardProps) {
  const [open, setOpen] = useState(false);
  const hasChips = p.missing.length > 0 || p.pins.length > 0 || p.notes.length > 0;

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
          {!open && p.missing.length > 0 && (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              {p.missing.length} missing
            </span>
          )}
        </button>
        <span className="hidden flex-shrink-0 text-[11px] tabular-nums text-zinc-400 sm:inline">
          {p.widthMm} × {p.heightMm} mm
        </span>
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

          <div className="bg-zinc-100 p-4">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              Live preview · current data
            </div>
            <LazyOutputPreview
              src={`/api/admin/styles/${p.styleId}/output-preview?variantKey=${encodeURIComponent(p.variantKey)}`}
              widthMm={p.widthMm}
              heightMm={p.heightMm}
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
