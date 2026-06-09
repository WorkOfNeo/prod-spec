import { PDFParse } from "pdf-parse";

// =====================================================
// Parser for the "Barcodes" page of a Contrast Purchase Order PDF.
//
// The PO PDF (computer-generated, stable layout) has a page whose footer
// reads "Purchase Order C-PO<n> - Barcodes" with columns:
//   No. | Variant | Description | Barcode EAN | Polybag EAN | Carton | SU
//
// Two EAN levels show up in the flattened text:
//   • per colour/size variant rows — a label ("A-ONE SIZE Colour A , One
//     size") followed by the 13-digit Barcode EAN. THIS is the per-size
//     EAN we put on the style. The trailing "SU" (e.g. "6/6") is optional.
//   • assortment rows ("ASS1" / "ASS2") and standalone EAN lines
//     ("6937128542362  12/12") — polybag/carton-level EANs, captured
//     separately in `assortmentEans`.
//
// Items are keyed by Customer Item No (e.g. "316-246-1024") which matches
// the Pre-Order style's Customer Item No (column text91__1). The "No."
// column ("C-27865") is Contrast's internal article number. One PO can
// carry multiple items (styles).
// =====================================================

export type PoVariant = {
  /** Colour/size label, e.g. "A-ONE SIZE Colour A , One size". */
  label: string;
  /** Per-unit EAN-13 (the "Barcode EAN" column). */
  ean13: string;
  /** "SU per polybag/carton", e.g. "6/6" — optional. */
  unitsPer: string | null;
};

export type PoItem = {
  /** Contrast internal article no., e.g. "C-27865". */
  contrastNo: string | null;
  /** Customer Item No, e.g. "316-246-1024" — the match key to a style. */
  customerItemNo: string | null;
  /** Per colour/size Barcode EANs. */
  variants: PoVariant[];
  /** Assortment / polybag / carton-level EANs (not per-size). */
  assortmentEans: string[];
};

export type ParsedPo = {
  /** "C-PO61712" */
  poNumber: string | null;
  items: PoItem[];
  /** Raw text of the Barcodes page — kept for debugging / refinement. */
  rawBarcodePage: string;
  /** Verification signals about the PDF we just read. */
  diagnostics: {
    pageCount: number;
    fullTextLength: number;
    /** Did we locate a "Barcodes" page at all? */
    barcodePageFound: boolean;
    /** Distinct 13-digit tokens anywhere in the doc — "are there any
     *  barcodes in this file at all", independent of the page parser. */
    ean13TokensInFullText: number;
    /** First ~600 chars of the Barcodes page (or whole doc) for eyeballing. */
    textSnippet: string;
  };
};

const RE_CUSTOMER_ITEM = /\b\d{3}-\d{3}-\d{4}\b/; // 316-246-1024
const RE_CONTRAST_NO = /\bC-\d{3,}\b/; // C-27865 (C-PO/C-SO have letters → excluded)
const RE_STANDALONE_EAN = /^(\d{13})(?:\s+\d{1,4}\s*\/\s*\d{1,4})?\s*$/; // "693… 12/12"
const RE_LABELED_EAN = /^(.+?)\s+(\d{13})(?:\s+(\d{1,4}\s*\/\s*\d{1,4}))?\s*$/;

export async function parsePoBarcodes(pdf: Buffer): Promise<ParsedPo> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const result = await parser.getText();
    const fullText = result.text ?? "";
    const pages: Array<{ text?: string }> =
      (result as { pages?: Array<{ text?: string }> }).pages ?? [];
    const page =
      pages.find((p) => /barcode\s*ean/i.test(p.text ?? "")) ??
      pages.find((p) => /-\s*Barcodes/i.test(p.text ?? ""));
    const raw = page?.text ?? "";

    const poNumber =
      raw.match(/Purchase Order\s+(C-\S+?)\s*-\s*Barcodes/i)?.[1] ??
      fullText.match(/Purchase Order\s+(C-PO\w+)/i)?.[1] ??
      null;

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items: PoItem[] = [];
    let current: PoItem | null = null;
    const ensure = (): PoItem => {
      if (!current) {
        current = { contrastNo: null, customerItemNo: null, variants: [], assortmentEans: [] };
        items.push(current);
      }
      return current;
    };

    for (const line of lines) {
      const standalone = line.match(RE_STANDALONE_EAN);
      const labeled = standalone ? null : line.match(RE_LABELED_EAN);
      const contrastNo = line.match(RE_CONTRAST_NO)?.[0] ?? null;
      const custItem = line.match(RE_CUSTOMER_ITEM)?.[0] ?? null;

      // A Contrast "No." header line (no EAN on it) opens a new item.
      if (contrastNo && !standalone && !labeled) {
        current = { contrastNo, customerItemNo: custItem, variants: [], assortmentEans: [] };
        items.push(current);
        continue;
      }

      // Skip noise lines (page header, wrapped description, carton codes)
      // so they don't spawn empty items.
      if (!standalone && !labeled && !custItem) continue;

      const item = ensure();
      if (custItem && !item.customerItemNo) item.customerItemNo = custItem;

      // Standalone EAN line → assortment/carton-level.
      if (standalone) {
        item.assortmentEans.push(standalone[1]);
        continue;
      }

      // Labeled EAN row → per-size/colour variant, unless it's an
      // assortment ("ASS1"/"ASS2") line.
      if (labeled) {
        let label = labeled[1].trim();
        const ci = label.match(RE_CUSTOMER_ITEM)?.[0];
        if (ci) {
          if (!item.customerItemNo) item.customerItemNo = ci;
          label = label.replace(ci, "").trim();
        }
        const ean13 = labeled[2];
        const unitsPer = labeled[3] ? labeled[3].replace(/\s/g, "") : null;
        // A line that is "<EAN> <EAN> [ratio]" (the label is itself a bare
        // 13-digit number) is a pack/assortment EAN row, not a per-size
        // variant — e.g. a 2-pack wrapper's carton barcode.
        const labelIsEan = /^\d{13}$/.test(label);
        if (/^ASS\d*\b/i.test(label) || !label || labelIsEan) {
          if (labelIsEan) item.assortmentEans.push(label);
          item.assortmentEans.push(ean13);
        } else {
          item.variants.push({ label: label.replace(/\s+/g, " ").trim(), ean13, unitsPer });
        }
      }
    }

    const ean13Distinct = new Set(fullText.match(/(?<!\d)\d{13}(?!\d)/g) ?? []);
    return {
      poNumber,
      items,
      rawBarcodePage: raw,
      diagnostics: {
        pageCount: pages.length,
        fullTextLength: fullText.length,
        barcodePageFound: Boolean(page),
        ean13TokensInFullText: ean13Distinct.size,
        textSnippet: (raw || fullText).slice(0, 600),
      },
    };
  } finally {
    await parser.destroy();
  }
}

// Flatten to (customerItemNo → per-size variants) for linking onto a style
// by its Customer Item No.
export function variantsByCustomerItemNo(parsed: ParsedPo): Map<string, PoVariant[]> {
  const map = new Map<string, PoVariant[]>();
  for (const item of parsed.items) {
    const key = item.customerItemNo ?? item.contrastNo;
    if (!key || item.variants.length === 0) continue;
    map.set(key, [...(map.get(key) ?? []), ...item.variants]);
  }
  return map;
}
