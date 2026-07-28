import type { EanDiagnostics } from "./ean-view";
import type { SizeEan } from "./resolve-style-eans";
import type { MondayFallbackResult, MondayCartonOverlay } from "./monday-barcode-fallback";

// =====================================================
// Persisted "what did the last resolve actually do" snapshot (Style.eanResolveTrace).
//
// The problem it solves: eanStatus is one enum. A style reading
// "resolved (Monday)" tells you the fallback won, but not that the PO scrape
// failed first, not what it searched for, and not what the buyer had typed into
// the Monday columns that rescued it. So "did a code change break scraping?" was
// unanswerable from the UI — the only evidence was a Log row keyed by nothing
// useful, and the live EanDiagnostics vanished when the page reloaded.
//
// This module is a DB-free leaf: it shapes the pieces the resolver already
// produces into a compact, storable trace. Kept pure so it can be unit-tested
// without a DATABASE_URL, on the same principle as supplier-digest.ts.
//
// Deliberately NOT the raw EanDiagnostics: that carries a text snippet, the
// full candidate list and a per-section variant dump — fine for a live panel,
// far too heavy to write on every resolve of every style. What survives here is
// the decision trail, plus the two raw Monday column strings (short, and the
// single most useful thing when a barcode looks wrong).
// =====================================================

export type EanSizeSource = "po" | "monday" | "none";

export type EanResolveTrace = {
  v: 1;
  at: string; // ISO timestamp of the resolve
  status: string; // the eanStatus written
  message: string | null;
  // A human forced the Monday fallback (the /po-eans + style-page Re-resolve)
  // rather than it firing because the PO retry budget ran out.
  forced: boolean;
  po: {
    poNumber: string | null;
    found: boolean;
    fileName: string | null;
    fileUrl: string | null;
    barcodePageFound: boolean;
    sectionsParsed: number;
    variantsUsable: number;
    matchedBy: "customerItemNo" | "styleNumber" | "rejected" | "fallback-all";
    poStyleNumbers: string[];
    styleNumberOnStyle: string | null;
    customerItemNoOnStyle: string | null;
    colourCode: string | null;
    colourScopeApplied: boolean;
    variantsExcludedByColour: number;
    eansFound: number;
    outcome: string; // one sentence: what happened, in plain words
  } | null; // null = the scrape never ran (no PO number on the style)
  monday: {
    consulted: boolean;
    // fallback      → the whole scrape came from Monday
    // carton-overlay→ PO gave the product EANs, Monday's carton column won for cartons
    // not-needed    → the PO scrape succeeded and the carton column was empty
    // no-data       → we looked and both columns were empty
    mode: "fallback" | "carton-overlay" | "not-needed" | "no-data";
    // The RAW column text, exactly as read. The single most useful field when a
    // barcode looks wrong — it shows what the buyer actually typed.
    productField: string | null;
    cartonField: string | null;
    matchedSizes: number;
    assortEan: string | null;
    invalid: string[];
    outcome: string;
  };
  sizes: Array<{ size: string; ean13: string | null; cartonEan: string | null; source: EanSizeSource }>;
  carton: { perSize: number; assort: string | null };
};

function poOutcome(d: EanDiagnostics, eansFound: number, rejected: boolean): string {
  if (rejected) {
    return `PO found, but it lists ${d.poStyleNumbers.join(", ") || "no style numbers"} — not ${
      d.styleNumberOnStyle ?? "this style"
    }. Refused to scrape another style's barcodes.`;
  }
  if (!d.barcodePageFound) {
    return `PO PDF read (${d.pdfPageCount} page(s)) but no Barcodes page was found in it.`;
  }
  if (d.parsedItemCount === 0) {
    return "Barcodes page found but no style sections could be parsed from it.";
  }
  if (d.colourScopeApplied && d.parsedVariantCount === 0) {
    return `Colour code ${d.colourCodeOnStyle ?? ""} matched none of the PO's colourway rows (${
      d.variantsExcludedByColour
    } row(s) excluded).`;
  }
  if (eansFound === 0) {
    return `Parsed ${d.parsedItemCount} section(s) and ${d.parsedVariantCount} row(s), but none matched this style's sizes.`;
  }
  return `Read ${eansFound} barcode(s) from ${d.poFileName ?? "the PO"}.`;
}

function mondayOutcome(
  mode: EanResolveTrace["monday"]["mode"],
  fallback: MondayFallbackResult | null,
  overlay: MondayCartonOverlay | null,
  totalSizes: number,
): string {
  switch (mode) {
    case "fallback":
      return `Barcodes read from the Monday columns — ${fallback?.matchedSizes ?? 0} of ${totalSizes} size(s)${
        fallback?.assortEan ? " plus an Assort line" : ""
      }${fallback?.invalid.length ? `; ${fallback.invalid.length} invalid value(s) ignored` : ""}.`;
    case "carton-overlay":
      return `Product barcodes came from the PO; the Monday carton column was filled (${
        overlay?.bySize.length ?? 0
      } per-size${overlay?.assort ? " + Assort" : ""}) and won for carton EANs.`;
    case "no-data":
      return "Monday's barcode columns were read and both were empty.";
    default:
      return "Not needed — the PO scrape resolved everything and the carton column was empty.";
  }
}

// Build the trace. Every argument is something resolveAndPersistStyleEans
// already has in hand, so this adds no extra reads.
export function buildEanResolveTrace(input: {
  at: Date;
  status: string;
  message: string | null | undefined;
  forced: boolean;
  diagnostics: EanDiagnostics | undefined;
  poStatusWasReject: boolean;
  poSizeEans: SizeEan[]; // what the PO scrape produced, BEFORE any Monday overlay
  finalSizeEans: SizeEan[]; // what actually got persisted
  fallback: MondayFallbackResult | null;
  overlay: MondayCartonOverlay | null;
  mondayConsulted: boolean;
  cartonEan: string | null;
}): EanResolveTrace {
  const d = input.diagnostics;
  const poEansFound = input.poSizeEans.filter((s) => s.ean13).length;

  const mode: EanResolveTrace["monday"]["mode"] = input.fallback
    ? "fallback"
    : input.overlay
      ? "carton-overlay"
      : input.mondayConsulted
        ? "no-data"
        : "not-needed";

  // Per-size source attribution. The PO row is the reference: if the final EAN
  // matches what the PO produced for that size it came from the scrape,
  // otherwise Monday supplied it.
  const poBySize = new Map(input.poSizeEans.map((s) => [s.size, s.ean13]));
  const sizes = input.finalSizeEans.map((s) => ({
    size: s.size,
    ean13: s.ean13,
    cartonEan: s.cartonEan,
    source: (!s.ean13
      ? "none"
      : poBySize.get(s.size) === s.ean13
        ? "po"
        : "monday") as EanSizeSource,
  }));

  return {
    v: 1,
    at: input.at.toISOString(),
    status: input.status,
    message: input.message ?? null,
    forced: input.forced,
    po: d
      ? {
          poNumber: d.poNumber,
          found: d.poFileName != null,
          fileName: d.poFileName,
          fileUrl: d.poFileWebUrl,
          barcodePageFound: d.barcodePageFound,
          sectionsParsed: d.parsedItemCount,
          variantsUsable: d.parsedVariantCount,
          matchedBy: input.poStatusWasReject
            ? "rejected"
            : d.matchedByCustomerItemNo
              ? "customerItemNo"
              : d.matchedByStyleNumber
                ? "styleNumber"
                : "fallback-all",
          poStyleNumbers: d.poStyleNumbers,
          styleNumberOnStyle: d.styleNumberOnStyle,
          customerItemNoOnStyle: d.customerItemNoOnStyle,
          colourCode: d.colourCodeOnStyle,
          colourScopeApplied: d.colourScopeApplied,
          variantsExcludedByColour: d.variantsExcludedByColour,
          eansFound: poEansFound,
          outcome: poOutcome(d, poEansFound, input.poStatusWasReject),
        }
      : null,
    monday: {
      consulted: input.mondayConsulted,
      mode,
      productField: input.fallback?.productField ?? null,
      cartonField: input.fallback?.cartonField ?? input.overlay?.cartonField ?? null,
      matchedSizes: input.fallback?.matchedSizes ?? 0,
      assortEan: input.fallback?.assortEan ?? input.overlay?.assort ?? null,
      invalid: input.fallback?.invalid ?? [],
      outcome: mondayOutcome(mode, input.fallback, input.overlay, input.finalSizeEans.length),
    },
    sizes,
    carton: {
      perSize: input.finalSizeEans.filter((s) => s.cartonEan).length,
      assort: input.cartonEan,
    },
  };
}

// Defensive parse for the read side. The column ships in the same PR as its
// migration, but a pod serving traffic between deploy and `migrate deploy`
// would otherwise 500 on a field Prisma knows and Postgres doesn't — and an
// older trace shape must never break the panel either.
export function parseEanResolveTrace(raw: unknown): EanResolveTrace | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<EanResolveTrace>;
  if (t.v !== 1 || typeof t.at !== "string" || !t.monday || !Array.isArray(t.sizes)) return null;
  return t as EanResolveTrace;
}
