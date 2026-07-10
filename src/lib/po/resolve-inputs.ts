import { MANUAL_COLUMN_IDS, type ColumnMapping } from "@/lib/customers/config";

// =====================================================
// The Style fields that determine WHICH PO barcodes get scraped and how they
// are placed onto the size run. resolveStyleEans() reads these to build the
// style_eans snapshot; the job runner fingerprints them (eanResolveKey) so a
// later Sizes / Colour-code edit on Monday — which changes the resolved output
// but leaves the PO number untouched, so ingest doesn't re-queue a resolve —
// is detected and re-resolved before the PDFs render. Keeping the read logic
// in one place means the resolver and the staleness check can never drift.
// =====================================================

export type EanResolveInputs = {
  poNumber: string | null;
  customerItemNo: string;
  styleNumber: string;
  sizes: string[];
  colourCode: string;
};

function rawCols(
  rawData: unknown,
): Array<{ id?: string; text?: string | null; display_value?: string | null }> {
  const cv = (rawData as { column_values?: unknown })?.column_values;
  return Array.isArray(cv) ? cv : [];
}

// Read a column by id, trying both the native and the legacy "po."-prefixed
// form so this works whether the style was sourced from Pre-Order (native)
// or the old Styles board + enrichment (po.*).
export function readCol(rawData: unknown, ...ids: string[]): string {
  const cols = rawCols(rawData);
  for (const id of [...ids, ...ids.map((i) => `po.${i}`)]) {
    const c = cols.find((x) => x.id === id);
    const v = (c?.text ?? "").trim() || (c?.display_value ?? "").trim();
    if (v) return v;
  }
  return "";
}

// Split a size list into labels. Only "," / ";" separate labels — NOT "/",
// because combined sizes are written with slashes ("S/M", "L/XL") and must
// stay intact to match both the PO variant labels and the EAN-map keys.
export function splitSizes(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Derive the resolve-input tuple from a Style's Monday snapshot under the SAME
// mapping the PDF mapper uses (ProdSpec override → Customer config → defaults),
// with the manual.* fallback. `styleName` backs the styleNumber (the Pre-Order
// row name / IL-code) when no column carries it — the primary key for
// multi-style POs.
export function eanResolveInputs(
  rawData: unknown,
  mapping: ColumnMapping,
  styleName: string,
  poNumber: string | null,
): EanResolveInputs {
  const customerItemNo = readCol(
    rawData,
    mapping.customerItemNo ?? "text91__1",
    MANUAL_COLUMN_IDS.customerItemNo,
  );
  const styleNumber =
    readCol(rawData, mapping.styleNumber ?? "__name__", MANUAL_COLUMN_IDS.styleNumber) || styleName;
  const sizes = splitSizes(readCol(rawData, mapping.sizes ?? "sizes__1", MANUAL_COLUMN_IDS.sizes));
  const colourCode = readCol(
    rawData,
    mapping.colourCode ?? "dropdown__1",
    MANUAL_COLUMN_IDS.colourCode,
  );
  return { poNumber, customerItemNo, styleNumber, sizes, colourCode };
}

// Stable fingerprint of the resolve inputs. Stored on Style.eanResolveKey at
// resolve time and recomputed before each render — a difference means a
// Sizes / Colour-code (or Customer Item No / style number) edit landed since
// the last scrape, so the style_eans snapshot is stale and must be re-resolved
// before the PDFs are built. JSON is used (rather than a joined string) so an
// array boundary in one field can never masquerade as another's value.
export function eanResolveKey(inputs: EanResolveInputs): string {
  return JSON.stringify([
    inputs.poNumber ?? "",
    inputs.styleNumber,
    inputs.customerItemNo,
    inputs.colourCode,
    inputs.sizes,
  ]);
}
