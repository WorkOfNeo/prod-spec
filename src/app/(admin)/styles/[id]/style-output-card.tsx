"use client";

import { LazyOutputPreview } from "@/components/output-preview";
import { OutputThumbnail } from "./output-thumbnail";
import { RunOutputButton } from "./run-output-button";

// One output of one style, as a card: LIVE preview rendered from the
// style's current data (same assembly as the real render — see
// /api/admin/styles/[id]/output-preview), missing-field chips, pins,
// data notes, the per-output Run button, and the LAST GENERATED artifact
// alongside. "Live preview" and "last generated" legitimately differ when
// the Monday row changed after the last run — both are labelled so the
// operator never has to guess which is which.
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
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                p.ready ? "bg-emerald-500" : "bg-zinc-300"
              }`}
            />
            <h3 className="truncate text-sm font-semibold text-zinc-900" title={p.name}>
              {p.name}
            </h3>
          </div>
          <RunOutputButton
            styleId={p.styleId}
            variantKey={p.variantKey}
            ready={p.ready}
            missingLabels={p.missing}
          />
        </div>
        {(p.missing.length > 0 || p.pins.length > 0 || p.notes.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
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
      </div>

      <div className="flex-1 bg-zinc-100 p-4">
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
  );
}
