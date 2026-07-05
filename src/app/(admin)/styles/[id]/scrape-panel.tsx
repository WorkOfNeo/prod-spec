import type { EanDiagnostics } from "@/lib/po/ean-view";

export type PoSection = EanDiagnostics["poSections"][number];

// "What was in the PO scrape" — every section the Barcodes page carried, with
// the one(s) we matched for this style highlighted green. Makes the match
// auditable: you can see exactly which section's barcodes flowed to EAN-13 (per
// size) and that the others were left untouched. Live-only (diagnostics aren't
// persisted), so it appears after a Resolve / Re-resolve, not on first load.
export function ScrapePanel({ sections }: { sections: PoSection[] }) {
  const selected = sections.filter((s) => s.selected);
  const others = sections.filter((s) => !s.selected);
  const ordered = [...selected, ...others];

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700">
        PO scrape — {sections.length} section{sections.length === 1 ? "" : "s"} found
        {selected.length > 0 ? (
          <span className="font-normal text-zinc-500"> · green = used for this style</span>
        ) : (
          <span className="font-normal text-rose-600"> · none matched this style</span>
        )}
      </div>
      <div className="divide-y divide-zinc-100">
        {ordered.map((s, i) => (
          <SectionRow key={i} s={s} />
        ))}
      </div>
      <div className="border-t border-zinc-100 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
        {selected.length > 0 ? (
          <>
            Only the green {selected.length === 1 ? "section feeds" : "sections feed"}{" "}
            <span className="font-medium text-zinc-600">EAN-13 (per size)</span>. The rest are shown
            for verification only — nothing else is stored.
          </>
        ) : (
          <>No section matched this style, so no per-size EANs were stored.</>
        )}
      </div>
    </div>
  );
}

function SectionRow({ s }: { s: PoSection }) {
  const title = s.styleNumber ?? s.contrastNo ?? "(unlabelled section)";

  if (s.selected) {
    return (
      <div className="bg-emerald-50 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-emerald-900">{title}</span>
          <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
            → EAN-13 (per size)
          </span>
        </div>
        {s.variants.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {s.variants.map((v, i) =>
              // A selected section can still carry rows that are NOT this
              // style's — another colourway's, excluded by the Colour code
              // "*X" scope. Show them dimmed so the exclusion is auditable.
              v.used ? (
                <li key={i} className="flex justify-between gap-3 text-xs tabular-nums">
                  <span className="text-zinc-600">{v.label}</span>
                  <span className="font-medium text-zinc-800">{v.ean13}</span>
                </li>
              ) : (
                <li key={i} className="flex justify-between gap-3 text-xs tabular-nums text-zinc-400">
                  <span>
                    {v.label}
                    <span className="ml-1.5 rounded bg-zinc-100 px-1 py-px text-[10px] text-zinc-500">
                      other colourway — not used
                    </span>
                  </span>
                  <span>{v.ean13}</span>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-zinc-500">No per-size barcodes in this section.</p>
        )}
        {s.cartonEan && (
          <div className="mt-1 text-[11px] tabular-nums text-zinc-500">
            carton <span className="font-medium text-zinc-700">{s.cartonEan}</span>
          </div>
        )}
      </div>
    );
  }

  const sample = s.variants[0]?.ean13 ?? (s.cartonEan ? `carton ${s.cartonEan}` : null);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-zinc-500">
      <span>{title}</span>
      <span className="tabular-nums text-zinc-400">
        {s.variants.length} size{s.variants.length === 1 ? "" : "s"}
        {sample ? ` · ${sample}` : ""}
      </span>
    </div>
  );
}
