import { db } from "@/lib/db";
import { downloadDriveItem } from "@/lib/sharepoint/shares";
import { findPoPdfDetailed } from "./find-po-pdf";
import {
  parsePoBarcodes,
  selectStyleItems,
  cartonEanFor,
  variantsWithSectionCarton,
  type PoVariant,
} from "./parse-barcodes";
import { labelHasSize } from "./size-match";
import type { EanDiagnostics } from "./ean-view";
import { parseCustomerConfig, MANUAL_COLUMN_IDS, type ColumnMapping } from "@/lib/customers/config";
import { parseProdSpecColumnMapping } from "@/lib/prod-spec/config";

// =====================================================
// End-to-end EAN resolution for one Style:
//   Style.poNumber (from Pre-Order) + Style.supplier.sharepointUrl
//   → find "Purchase Order <PO>.pdf" in the supplier folder
//   → parse the Barcodes page
//   → select the style's section(s): by Customer Item No, else by style number
//   → place each per-colour/size Barcode EAN in the Style's size order
//   → plus the carton/assortment EAN.
//
// A PO can carry many styles. We pick by the style number printed on each
// section's header, and REJECT (STYLE_NOT_IN_PO) when the PO has style-number
// sections but none is ours — guessing would write a different style's EANs.
// =====================================================

export type SizeEan = {
  size: string;
  ean13: string | null;
  variantLabel: string | null;
  // Carton EAN of the PO section this row's variant came from — per colourway,
  // since each colour is its own section with its own carton. Null when the
  // section carries no carton / no variant matched.
  cartonEan: string | null;
};

export type StyleEanStatus =
  | "ok"
  | "partial"
  | "no_po"
  | "no_supplier_folder"
  | "po_not_found"
  // PO found + parsed and it carries style sections, but none matches this
  // style's style number → we refuse to scrape another style's EANs.
  | "style_not_in_po"
  | "no_eans"
  | "error";

export type StyleEanResult = {
  styleId: string;
  styleName: string;
  poNumber: string | null;
  supplierName: string | null;
  folderUrl: string | null;
  poFileName: string | null;
  status: StyleEanStatus;
  message?: string;
  sizeEans: SizeEan[];
  cartonEan: string | null;
  unmatchedVariants: PoVariant[];
  diagnostics?: EanDiagnostics;
};

function rawCols(rawData: unknown): Array<{ id?: string; text?: string | null; display_value?: string | null }> {
  const cv = (rawData as { column_values?: unknown })?.column_values;
  return Array.isArray(cv) ? cv : [];
}

// Read a column by id, trying both the native and the legacy "po."-prefixed
// form so this works whether the style was sourced from Pre-Order (native)
// or the old Styles board + enrichment (po.*).
function readCol(rawData: unknown, ...ids: string[]): string {
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
function splitSizes(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function resolveStyleEans(styleId: string): Promise<StyleEanResult> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      id: true,
      name: true,
      poNumber: true,
      rawData: true,
      mondayBoardId: true,
      supplier: { select: { name: true, sharepointUrl: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { columnMapping: true } },
    },
  });
  if (!style) {
    return {
      styleId,
      styleName: "(unknown)",
      poNumber: null,
      supplierName: null,
      folderUrl: null,
      poFileName: null,
      status: "error",
      message: "Style not found",
      sizeEans: [],
      cartonEan: null,
      unmatchedVariants: [],
    };
  }

  const base: StyleEanResult = {
    styleId: style.id,
    styleName: style.name,
    poNumber: style.poNumber,
    supplierName: style.supplier?.name ?? null,
    folderUrl: style.supplier?.sharepointUrl ?? null,
    poFileName: null,
    status: "ok",
    sizeEans: [],
    cartonEan: null,
    unmatchedVariants: [],
  };

  if (!style.poNumber) return { ...base, status: "no_po", message: "Style has no PO number" };

  // Resolve sizes / Customer Item No through the SAME column mapping the PDF
  // mapper uses (ProdSpec override → Customer config → defaults), with the
  // manual.* fallback. Without this, customers whose sizes live in a
  // non-default column — or were hand-entered (manual.sizes) — resolve to
  // empty and get mis-handled as "unknown sizes" (raw variants dumped).
  const config = parseCustomerConfig(style.customer?.config);
  const prodSpecMapping =
    style.prodSpec && Object.keys((style.prodSpec.columnMapping as object) ?? {}).length > 0
      ? parseProdSpecColumnMapping(style.prodSpec.columnMapping)
      : null;
  const mapping: ColumnMapping = prodSpecMapping ?? config.columnMapping;

  const customerItemNo = readCol(
    style.rawData,
    mapping.customerItemNo ?? "text91__1",
    MANUAL_COLUMN_IDS.customerItemNo,
  );
  // The style number printed on the PO section headers. Default maps to the
  // Pre-Order row name (synthetic "__name__" column = Style.name, e.g.
  // "PTQ60031"); fall back to Style.name directly so a missing mapping still
  // resolves. This is the primary match key for multi-style POs.
  const styleNumber =
    readCol(style.rawData, mapping.styleNumber ?? "__name__", MANUAL_COLUMN_IDS.styleNumber) ||
    style.name;
  const sizes = splitSizes(
    readCol(style.rawData, mapping.sizes ?? "sizes__1", MANUAL_COLUMN_IDS.sizes),
  );

  // Find the PO PDF by searching the central Suppliers drive for the
  // (unique) PO number — robust to messy per-supplier folder URLs. We keep
  // the full ranked candidate list so a PO_FOUND_NO_EANS can be checked
  // against "was there a better-matching (e.g. dedicated barcode) PDF?".
  let search: Awaited<ReturnType<typeof findPoPdfDetailed>>;
  try {
    search = await findPoPdfDetailed(style.poNumber);
  } catch (e) {
    return { ...base, status: "error", message: `SharePoint: ${(e as Error).message}` };
  }
  const candidates = search.candidates.slice(0, 8);
  const po = search.chosen;
  if (!po) {
    return {
      ...base,
      status: "po_not_found",
      message: `No PO PDF found for "${style.poNumber}" (searched ${search.queriesTried.join(", ")})`,
      diagnostics: {
        poNumber: style.poNumber,
        poFileName: null,
        poFileId: null,
        candidateCount: 0,
        candidates,
        queriesTried: search.queriesTried,
        poFileWebUrl: null,
        supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
        barcodePageFound: false,
        pdfPageCount: 0,
        pdfTextLength: 0,
        ean13TokensInFullText: 0,
        parsedItemCount: 0,
        parsedVariantCount: 0,
        matchedByCustomerItemNo: false,
        matchedByStyleNumber: false,
        customerItemNoOnStyle: customerItemNo || null,
        styleNumberOnStyle: styleNumber || null,
        poStyleNumbers: [],
        poSections: [],
        styleSizes: sizes,
        textSnippet: "",
      },
    };
  }

  const buf = await downloadDriveItem(po);
  if (!buf) {
    return {
      ...base,
      status: "error",
      poFileName: po.name,
      message: "Download failed",
      diagnostics: {
        poNumber: style.poNumber,
        poFileName: po.name,
        poFileId: po.id,
        candidateCount: search.candidates.length,
        candidates,
        queriesTried: search.queriesTried,
        poFileWebUrl: po.webUrl ?? null,
        supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
        barcodePageFound: false,
        pdfPageCount: 0,
        pdfTextLength: 0,
        ean13TokensInFullText: 0,
        parsedItemCount: 0,
        parsedVariantCount: 0,
        matchedByCustomerItemNo: false,
        matchedByStyleNumber: false,
        customerItemNoOnStyle: customerItemNo || null,
        styleNumberOnStyle: styleNumber || null,
        poStyleNumbers: [],
        poSections: [],
        styleSizes: sizes,
        textSnippet: "",
      },
    };
  }

  // A PDF we located and downloaded but pdf.js can't read — corrupt/encrypted
  // bytes, or a pdfjs runtime fault (e.g. a worker/API version mismatch). Mirror
  // the other failure branches: return a typed `error` result naming the file
  // and the underlying reason, rather than letting an opaque low-level
  // exception throw up to the runner (logged as a bare ⨯) or the re-resolve
  // route (surfaced as a 500).
  let parsed: Awaited<ReturnType<typeof parsePoBarcodes>>;
  try {
    parsed = await parsePoBarcodes(buf);
  } catch (e) {
    return {
      ...base,
      status: "error",
      poFileName: po.name,
      message: `Failed to parse PO PDF "${po.name}": ${(e as Error).message}`,
      diagnostics: {
        poNumber: style.poNumber,
        poFileName: po.name,
        poFileId: po.id,
        candidateCount: search.candidates.length,
        candidates,
        queriesTried: search.queriesTried,
        poFileWebUrl: po.webUrl ?? null,
        supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
        barcodePageFound: false,
        pdfPageCount: 0,
        pdfTextLength: 0,
        ean13TokensInFullText: 0,
        parsedItemCount: 0,
        parsedVariantCount: 0,
        matchedByCustomerItemNo: false,
        matchedByStyleNumber: false,
        customerItemNoOnStyle: customerItemNo || null,
        styleNumberOnStyle: styleNumber || null,
        poStyleNumbers: [],
        poSections: [],
        styleSizes: sizes,
        textSnippet: "",
      },
    };
  }

  // Pick the PO section(s) for this style: Customer Item No → style number →
  // reject (PO has style sections, none ours) → all-items fallback. See
  // selectStyleItems for the full rationale.
  const selection = selectStyleItems(parsed.items, { customerItemNo, styleNumber });
  const selectedItems = selection.items;
  // Carry each section's own carton EAN onto its variants so a multi-colourway
  // style (one section per colour) keeps the carton paired with the right
  // colour rather than collapsing to the first section's carton.
  const variants = variantsWithSectionCarton(selectedItems);
  // Single representative carton for non-repeating outputs + Style.cartonEan.
  const cartonEan = cartonEanFor(selectedItems, parsed.items);

  // Every section the scrape saw, flagged with whether we selected it — for
  // the "full scrape, green = used" panel. selectStyleItems returns the same
  // PoItem references it filtered from parsed.items, so identity works.
  const selectedSet = new Set(selectedItems);
  const poSections = parsed.items.map((it) => ({
    styleNumber: it.styleNumber,
    contrastNo: it.contrastNo,
    selected: selectedSet.has(it),
    variants: it.variants.map((v) => ({ label: v.label, ean13: v.ean13 })),
    cartonEan: it.assortmentEans[0] ?? null,
  }));

  const diagnostics: EanDiagnostics = {
    poNumber: style.poNumber,
    poFileName: po.name,
    poFileId: po.id,
    candidateCount: search.candidates.length,
    candidates,
    queriesTried: search.queriesTried,
    poFileWebUrl: po.webUrl ?? null,
    supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
    barcodePageFound: parsed.diagnostics.barcodePageFound,
    pdfPageCount: parsed.diagnostics.pageCount,
    pdfTextLength: parsed.diagnostics.fullTextLength,
    ean13TokensInFullText: parsed.diagnostics.ean13TokensInFullText,
    parsedItemCount: parsed.items.length,
    parsedVariantCount: variants.length,
    matchedByCustomerItemNo: selection.kind === "customerItemNo",
    matchedByStyleNumber: selection.kind === "styleNumber",
    customerItemNoOnStyle: customerItemNo || null,
    styleNumberOnStyle: styleNumber || null,
    poStyleNumbers: selection.poStyleNumbers,
    poSections,
    styleSizes: sizes,
    textSnippet: parsed.diagnostics.textSnippet,
  };

  // The PO carries style-number sections but none matches this style — reject
  // rather than scrape another style's EANs (every style shares the same size
  // run, so the old all-items fallback would silently mislabel them).
  if (selection.kind === "reject") {
    return {
      ...base,
      status: "style_not_in_po",
      poFileName: po.name,
      message: `Style "${styleNumber}" is not in PO ${po.name} — it lists ${
        selection.poStyleNumbers.join(", ") || "(no style numbers)"
      }.`,
      cartonEan: null,
      diagnostics,
    };
  }

  // Match each style size to EVERY variant whose label carries that size, so
  // a 2-pack style gets one row per (colour × size). Duplicate sizes across
  // colourways are intentional (the EAN differs per colour).
  const sizeEans: SizeEan[] = [];
  const used = new Set<number>();
  if (sizes.length === 0) {
    // Unknown style sizes → surface variants directly using their labels.
    variants.forEach((v, i) => {
      sizeEans.push({ size: v.label, ean13: v.ean13, variantLabel: v.label, cartonEan: v.cartonEan });
      used.add(i);
    });
  } else {
    for (const size of sizes) {
      let any = false;
      variants.forEach((v, i) => {
        if (labelHasSize(v.label, size)) {
          sizeEans.push({ size, ean13: v.ean13, variantLabel: v.label, cartonEan: v.cartonEan });
          used.add(i);
          any = true;
        }
      });
      // Single size + single variant → pair them even if labels differ.
      if (!any && sizes.length === 1 && variants.length === 1) {
        sizeEans.push({
          size,
          ean13: variants[0].ean13,
          variantLabel: variants[0].label,
          cartonEan: variants[0].cartonEan,
        });
        used.add(0);
        any = true;
      }
      if (!any) sizeEans.push({ size, ean13: null, variantLabel: null, cartonEan: null });
    }
  }
  const unmatched = variants.filter((_, i) => !used.has(i));

  const anyEan = sizeEans.some((s) => s.ean13);
  const status: StyleEanStatus = !anyEan
    ? "no_eans"
    : sizeEans.some((s) => !s.ean13) || unmatched.length > 0
      ? "partial"
      : "ok";

  return {
    ...base,
    poFileName: po.name,
    sizeEans,
    cartonEan,
    unmatchedVariants: unmatched,
    status,
    diagnostics,
  };
}
