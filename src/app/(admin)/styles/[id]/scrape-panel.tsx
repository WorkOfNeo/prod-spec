import { formatDate } from "@/lib/utils";
import type { EanDiagnostics } from "@/lib/po/ean-view";

// The section shape this panel renders. Both sources speak it: the live
// EanDiagnostics.poSections and the persisted PoScrapeSnapshot.sections, which
// stores exactly these fields (scrape-snapshot.ts). Keeping the alias pointed
// at the diagnostics type means tsc flags the drift at the call site if the
// two ever diverge, rather than the stored dump silently losing a field.
export type PoSection = EanDiagnostics["poSections"][number];

// Where the dump on screen came from. Absent = a live resolve that just ran;
// present = read back from Style.poScrapeSnapshot, which MUST be labelled —
// a stored dump can predate the PO being re-issued, and stale data that reads
// as live is worse than no data at all.
export type StoredScrapeProvenance = {
  /** ISO timestamp of the scrape. Null on a pre-timestamp row. */
  scrapedAt: string | null;
  poFileName: string | null;
  poFileWebUrl: string | null;
  /** Sections the PO really had, before the storage cap. */
  sectionCount: number;
  /** True when the stored dump was capped — the list below isn't everything. */
  truncated: boolean;
};

// "What was in the PO scrape" — every section the Barcodes page carried, with
// the one(s) we matched for this style highlighted green. Makes the match
// auditable: you can see exactly which section's barcodes flowed to EAN-13 (per
// size) and that the others were left untouched. Renders on page load from the
// persisted snapshot (see `stored`), and from the fresher live diagnostics
// straight after a Resolve / Re-resolve.
export function ScrapePanel({
  sections,
  stored,
}: {
  sections: PoSection[];
  stored?: StoredScrapeProvenance | null;
}) {
  const selected = sections.filter((s) => s.selected);
  const others = sections.filter((s) => !s.selected);
  const ordered = [...selected, ...others];
  // The stored dump is capped, so its own length can understate the PO. Trust
  // the recorded total when we have one.
  const total = stored ? Math.max(stored.sectionCount, sections.length) : sections.length;

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700">
        PO scrape — {total} section{total === 1 ? "" : "s"} found
        {selected.length > 0 ? (
          <span className="font-normal text-zinc-500"> · green = used for this style</span>
        ) : (
          <span className="font-normal text-rose-600"> · none matched this style</span>
        )}
      </div>
      {stored && <StoredHeader stored={stored} shown={sections.length} total={total} />}
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
            for verification only — no other section&apos;s barcodes were stored on this style.
          </>
        ) : (
          <>No section matched this style, so no per-size EANs were stored.</>
        )}
      </div>
    </div>
  );
}

// Provenance line for a dump read back from Style.poScrapeSnapshot. Says WHEN
// and from WHICH FILE, because the alternative — a stored scrape that looks
// identical to a live one — invites acting on a dump taken before the PO was
// re-issued. The re-resolve button is right above it, so the reader can always
// refresh; they just need to know that they might want to.
function StoredHeader({
  stored,
  shown,
  total,
}: {
  stored: StoredScrapeProvenance;
  shown: number;
  total: number;
}) {
  return (
    <div className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-[11px] leading-relaxed text-zinc-500">
      Stored scrape
      {stored.scrapedAt && (
        <>
          {" from "}
          {/* Rendered on the server AND re-rendered in the browser after a
              re-resolve; formatDate pins the locale but not the timezone, so
              the two can legitimately disagree. Suppress rather than force UTC
              — every other date on this page is local, and a UTC-only oddball
              here would be read as the wrong time. */}
          <time dateTime={stored.scrapedAt} className="font-medium text-zinc-600" suppressHydrationWarning>
            {formatDate(stored.scrapedAt)}
          </time>
        </>
      )}
      {stored.poFileName && (
        <>
          {" · "}
          {stored.poFileWebUrl ? (
            <a
              href={stored.poFileWebUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-blue-600 underline"
            >
              {stored.poFileName} ↗
            </a>
          ) : (
            <span className="font-medium text-zinc-600">{stored.poFileName}</span>
          )}
        </>
      )}
      {stored.truncated && (
        <span className="text-amber-700">
          {" · "}
          showing {shown} of {total} sections (stored dump is capped)
        </span>
      )}
      <span className="text-zinc-400"> · re-resolve for a fresh read</span>
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
