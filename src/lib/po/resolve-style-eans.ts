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
import { colourLettersFromCode, scopeVariantsByColour, variantMatchesColour } from "./colour-scope";
import type { EanDiagnostics } from "./ean-view";
import { eanResolveInputs } from "./resolve-inputs";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
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

  // Customer Item No, style number (PO section-header match key), size run and
  // the 🎨 Colour code ("*A"/"*B" colourway marker — see colour-scope.ts) — all
  // read through the shared resolver so the runner's staleness fingerprint
  // (eanResolveKey) reads exactly the same values this scrape did.
  const { customerItemNo, styleNumber, sizes, colourCode } = eanResolveInputs(
    style.rawData,
    mapping,
    style.name,
    style.poNumber,
  );
  const colourLetters = colourLettersFromCode(colourCode);

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
        colourCodeOnStyle: colourCode || null,
        colourLetters,
        colourScopeApplied: false,
        variantsExcludedByColour: 0,
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
        colourCodeOnStyle: colourCode || null,
        colourLetters,
        colourScopeApplied: false,
        variantsExcludedByColour: 0,
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
        colourCodeOnStyle: colourCode || null,
        colourLetters,
        colourScopeApplied: false,
        variantsExcludedByColour: 0,
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
  const allVariants = variantsWithSectionCarton(selectedItems);
  // Scope to this style's own colourway when the Colour code carries a "*X"
  // letter and the PO rows are letter-marked — one selected section can list
  // SEVERAL colourways that belong to DIFFERENT Pre-Order rows, and without
  // this every size collects the other colour's EAN too.
  const colourScope = scopeVariantsByColour(allVariants, colourCode);
  const variants = colourScope.variants;
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
    // `used` mirrors the colour scope: on a selected section, a row of another
    // colourway is shown but flagged as not feeding EAN-13 (per size).
    variants: it.variants.map((v) => ({
      label: v.label,
      ean13: v.ean13,
      used:
        selectedSet.has(it) &&
        (!colourScope.applied || variantMatchesColour(v.label, colourScope.letters)),
    })),
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
    colourCodeOnStyle: colourCode || null,
    colourLetters,
    colourScopeApplied: colourScope.applied,
    variantsExcludedByColour: colourScope.excluded,
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
    // The PO is letter-marked but no row carries this style's letter — a data
    // mismatch worth naming, since the safe alternative (grabbing the other
    // colourway's EANs) is exactly what scoping exists to prevent.
    message:
      colourScope.applied && variants.length === 0
        ? `Colour code ${colourLetters.map((l) => `*${l}`).join(", ")} matched none of the PO's colourway rows.`
        : undefined,
    sizeEans,
    cartonEan,
    unmatchedVariants: unmatched,
    status,
    diagnostics,
  };
}
