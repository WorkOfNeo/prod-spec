import { db } from "@/lib/db";
import { MONDAY_PRE_ORDER_BARCODE_COLS } from "@/lib/monday/boards";
import { parseCustomerConfig, MANUAL_COLUMN_IDS, type ColumnMapping } from "@/lib/customers/config";
import { parseProdSpecColumnMapping } from "@/lib/prod-spec/config";
import { parseBarcodeField, eanForSize } from "./monday-barcode-parse";
import type { SizeEan } from "./resolve-style-eans";

// =====================================================
// Monday barcode FALLBACK for the PO→EAN scrape.
//
// When the PO PDF scrape can't produce usable EANs and the retry budget is
// spent (or a human forces a re-resolve), we fall back to two text columns a
// buyer fills on the Pre-Order board:
//   • "Barcode Number"          (text_mm51c0mj) → per-size PRODUCT EAN-13
//   • "Carton Barcode number 1" (text_mm51twj9) → per-size CARTON EAN + Assort
//
// Parsing lives in ./monday-barcode-parse (pure, unit-tested). This module is
// the db-backed glue: it reads the columns off Style.rawData through the
// customer/ProdSpec column mapping and shapes the result like a PO scrape.
// =====================================================

function rawCols(
  rawData: unknown,
): Array<{ id?: string; text?: string | null; display_value?: string | null }> {
  const cv = (rawData as { column_values?: unknown })?.column_values;
  return Array.isArray(cv) ? cv : [];
}
function readCol(rawData: unknown, ...ids: string[]): string {
  const cols = rawCols(rawData);
  for (const id of [...ids, ...ids.map((i) => `po.${i}`)]) {
    const c = cols.find((x) => x.id === id);
    const v = (c?.text ?? "").trim() || (c?.display_value ?? "").trim();
    if (v) return v;
  }
  return "";
}
function splitSizes(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export type MondayFallbackResult = {
  sizeEans: SizeEan[];
  cartonEan: string | null;
  matchedSizes: number;
  assortEan: string | null;
  productField: string;
  cartonField: string;
  invalid: string[];
};

// Read the two Pre-Order barcode text columns for a style and build the same
// per-size EAN rows the PO scrape produces. Returns null when neither column
// yields anything usable (so the caller keeps the PO-scrape status and floats).
export async function resolveStyleEansFromMonday(styleId: string): Promise<MondayFallbackResult | null> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      customer: { select: { config: true } },
      prodSpec: { select: { columnMapping: true } },
    },
  });
  if (!style) return null;

  const config = parseCustomerConfig(style.customer?.config);
  const prodSpecMapping =
    style.prodSpec && Object.keys((style.prodSpec.columnMapping as object) ?? {}).length > 0
      ? parseProdSpecColumnMapping(style.prodSpec.columnMapping)
      : null;
  const mapping: ColumnMapping = prodSpecMapping ?? config.columnMapping;

  const sizes = splitSizes(readCol(style.rawData, mapping.sizes ?? "sizes__1", MANUAL_COLUMN_IDS.sizes));

  // Colour for the output's per-row colour column. The PO scrape derives this
  // from each variant's PO label; the Monday fallback has no such label, so it
  // used to stamp a literal "Monday fallback" — which then printed AS the
  // colour. Instead take the style's own Colour name, falling back to the
  // Colour code, off the mapped columns (defaults mirror DEFAULT_COLUMN_MAPPING
  // so a ProdSpec mapping that omits them still resolves). Empty when neither
  // is filled → the colour column stays blank rather than printing a stand-in.
  const colourName = readCol(style.rawData, mapping.colourName ?? "text_mktbynx8", MANUAL_COLUMN_IDS.colourName);
  // The Colour code column carries a "*" colourway marker (e.g. "*Blue", "*A").
  // Strip it on the fallback so the code prints as a plain colour ("Blue").
  const colourCode = readCol(style.rawData, mapping.colourCode ?? "dropdown__1", MANUAL_COLUMN_IDS.colourCode)
    .replace(/^\*+\s*/, "")
    .trim();
  const colourLabel = colourName || colourCode || null;

  const productField = readCol(style.rawData, MONDAY_PRE_ORDER_BARCODE_COLS.product);
  const cartonField = readCol(style.rawData, MONDAY_PRE_ORDER_BARCODE_COLS.carton);
  if (!productField && !cartonField) return null;

  const product = parseBarcodeField(productField);
  const carton = parseBarcodeField(cartonField);
  const invalid = [...product.invalid, ...carton.invalid];

  const sizeEans: SizeEan[] = [];
  if (sizes.length > 0) {
    for (const size of sizes) {
      let ean13 = eanForSize(size, product.bySize);
      let sizeCarton = eanForSize(size, carton.bySize);
      // Single-size exception: an unlabelled bare EAN pairs with the lone size.
      if (sizes.length === 1) {
        if (!ean13 && product.bareEans.length === 1) ean13 = product.bareEans[0];
        if (!sizeCarton && carton.bareEans.length === 1) sizeCarton = carton.bareEans[0];
      }
      sizeEans.push({
        size,
        ean13,
        variantLabel: ean13 || sizeCarton ? colourLabel : null,
        cartonEan: sizeCarton,
      });
    }
  }

  // Assort line → the single representative carton EAN (Style.cartonEan); else
  // the first per-size carton we did land.
  const assortEan = carton.assort ?? product.assort ?? null;
  // Style.cartonEan is the MASTER / assortment carton (drives {{assortEan}} and
  // the assortment sticker). Use the real "Assort" line only — do NOT fall back
  // to a per-size carton, so a style with no assort stays detectable and
  // surfaces the Assortment EAN as an editable field in review instead of
  // silently printing an arbitrary size's carton. Per-size cartons still live
  // on the per-row style_eans (sizeEans[].cartonEan), untouched.
  const cartonEan = assortEan;
  const matchedSizes = sizeEans.filter((s) => s.ean13).length;

  // Nothing usable — no product EANs and no carton value. Let the PO status stand.
  if (matchedSizes === 0 && !cartonEan) return null;

  return { sizeEans, cartonEan, matchedSizes, assortEan, productField, cartonField, invalid };
}
