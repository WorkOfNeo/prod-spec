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
// Each style section opens with a "No." header line — Contrast's internal
// article number ("C-33423") followed by the Description header
// "<style number> - <name>" ("PTQ60031 - Pyjamas"). One PO can carry many
// styles, so items are keyed by, in order of preference:
//   • Customer Item No ("316-246-1024", column text91__1) when present, else
//   • Style number ("PTQ60031"), matched against the Pre-Order style's name.
// The style-number key is what makes a MULTI-style PO safe to scrape — without
// it we can't tell which section's EANs belong to the style being resolved.
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
  /**
   * Style number from the section's Description header, e.g. "PTQ60031".
   * Every Contrast PO style section opens with "<No.> <style number> - <name>"
   * (and repeats it on the ASS row), so this is the match key for the common
   * case where the PO carries no Customer Item No — and what makes a
   * multi-style PO safe to scrape. Null when the header had no
   * style-number-shaped leading token (e.g. a Customer-Item-No layout).
   */
  styleNumber: string | null;
  /**
   * The section's Description header text with the "No." article no. stripped,
   * e.g. "ILC02001: IL18672B+IL18672C - 2-Pack Shirts". Retained so a style
   * can be matched by its NAME appearing in the header when the leading token
   * is a pack/consignment code rather than the style number (see
   * selectStyleItems' name-match tier). Null when there was no header text.
   */
  description: string | null;
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

// Pull the style number off a Description header, e.g. "PTQ60031 - Pyjamas" →
// "PTQ60031". The style number is the leading token before the " - <name>"
// separator. Returns null for Customer-Item-No-shaped (316-246-1024) or bare
// numeric tokens — those aren't style numbers, so a PO that leads with them has
// no style-number header and must keep the legacy "use all items" path.
function leadingStyleNumber(desc: string): string | null {
  let d = desc.trim();
  if (!d) return null;
  const sep = d.search(/\s[–—-]\s/); // " - " / " – " / " — "
  if (sep >= 0) d = d.slice(0, sep).trim();
  const token = d.split(/\s+/)[0]?.trim() ?? "";
  // Reject things that aren't style numbers: a Customer Item No (316-246-1024),
  // a Contrast article no (C-33434 — what a bare pack/assortment line leads
  // with), or a bare number. A PO that leads with these has no style header.
  if (!token || RE_CUSTOMER_ITEM.test(token) || RE_CONTRAST_NO.test(token) || /^\d+$/.test(token)) {
    return null;
  }
  return token;
}

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

    const items = parseBarcodeItems(raw);

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

// Parse the flattened Barcodes-page text into per-style items. Split out from
// parsePoBarcodes (which owns the PDF read) so it's unit-testable from raw text
// without a PDF fixture. Each Contrast "No." header line ("C-33423 PTQ60031 -
// Pyjamas") opens an item and carries the style number; the ASS row repeats it
// as a backup; the per-size rows below it are the variants.
export function parseBarcodeItems(raw: string): PoItem[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: PoItem[] = [];
  let current: PoItem | null = null;
  const ensure = (): PoItem => {
    if (!current) {
      current = {
        contrastNo: null,
        customerItemNo: null,
        styleNumber: null,
        description: null,
        variants: [],
        assortmentEans: [],
      };
      items.push(current);
    }
    return current;
  };

  for (const line of lines) {
    const standalone = line.match(RE_STANDALONE_EAN);
    const labeled = standalone ? null : line.match(RE_LABELED_EAN);
    const contrastNo = line.match(RE_CONTRAST_NO)?.[0] ?? null;
    const custItem = line.match(RE_CUSTOMER_ITEM)?.[0] ?? null;

    // A Contrast "No." header line (no EAN on it) opens a new item. The text
    // after the "No." is the Description header — pull the style number off it.
    if (contrastNo && !standalone && !labeled) {
      const header = line.replace(contrastNo, "").trim();
      current = {
        contrastNo,
        customerItemNo: custItem,
        styleNumber: leadingStyleNumber(header),
        description: header || null,
        variants: [],
        assortmentEans: [],
      };
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
        // Backup style-number/description capture: the ASS row also reads
        // "ASS1 PTQ60031 - Pyjamas …" — use it if the header line had none.
        const assHeader = label.replace(/^ASS\d*\s*/i, "").trim();
        if (!item.styleNumber) item.styleNumber = leadingStyleNumber(assHeader);
        if (!item.description && assHeader) item.description = assHeader;
      } else {
        item.variants.push({ label: label.replace(/\s+/g, " ").trim(), ean13, unitsPer });
      }
    }
  }

  return items;
}

// Case/punctuation-insensitive key for comparing style numbers ("PTQ-60031"
// and "ptq60031" both → "ptq60031").
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Candidate match keys for a (possibly messy) Pre-Order style name. The PO
// prints a CLEAN style number per section ("KH30109"), but Style.name often
// carries a market suffix ("KH30109 - CZ", "KH10155- CZ" — note the missing
// space) or is a multi-pack concatenation ("KH90051 E+KH90051 E…"). So we match
// on: the whole name, the leading token before a " - "/"+", AND the leading
// style-number-shaped run (letters→digits), which absorbs irregular suffixes.
function styleKeys(name: string): Set<string> {
  const keys = new Set<string>();
  const add = (s: string | undefined) => {
    const n = norm(s ?? "");
    if (n) keys.add(n);
  };
  add(name);
  add(name.split(/\s[-–—]\s|\+/)[0]);
  add(name.match(/^[a-z]{1,5}\d{3,}[a-z]?/i)?.[0]);
  return keys;
}

// Does a name look like a single, real style number ("PTQ60031", "KH10155 -
// CZ") — as opposed to a multi-pack concatenation ("X+Y"), a descriptive label
// ("JYSK [Espen small]"), or an assortment code? Only these are eligible to be
// REJECTED when absent from a multi-style PO; bundles / descriptive names can't
// be matched by style number at all, so they keep the take-all fallback and we
// never regress them.
function looksLikeStyleNumber(name: string): boolean {
  return !name.includes("+") && !name.includes("[") && /^[a-z]{1,5}\d{3,}[a-z]?/i.test(name.trim());
}

export type StyleItemSelection =
  | { kind: "customerItemNo" | "styleNumber" | "all"; items: PoItem[]; poStyleNumbers: string[] }
  | { kind: "reject"; items: []; poStyleNumbers: string[] };

// Which PO sub-items belong to this style, decided purely from the parsed PO
// (no DB / PDF, so it's directly unit-testable). Priority:
//   1. customerItemNo → that item alone (precise, where the PO carries it).
//   2. styleNumber    → every section whose header style number matches; this
//      is how Contrast POs identify styles and what makes a MULTI-style PO safe.
//   3. styleName      → the style's name appears in EXACTLY ONE section's
//      description header. Catches POs whose header leads with a pack/
//      consignment code ("ILC02001: IL18672B+IL18672C - …") so the style
//      number the mapper sees is the pack code, not the style — the real name
//      still sits in the description. Only fires on a unique hit, so an absent
//      or ambiguous name falls through untouched.
//   4. reject         → the PO HAS style-number sections but none is ours; we
//      must NOT fall through to "all items" (every style shares the same size
//      run, so that silently leaks another style's EANs). The caller maps this
//      to STYLE_NOT_IN_PO.
//   5. all            → no style-number headers at all (a different/legacy PO
//      layout): keep the old behaviour and aggregate every item's variants. A
//      per-style-order PO lists one style's colourways (+ a 2-pack wrapper that
//      carries only an assortment EAN), so this still collects a single style.
export function selectStyleItems(
  items: PoItem[],
  opts: { customerItemNo?: string; styleNumber?: string; consignmentCode?: string },
): StyleItemSelection {
  const poStyleNumbers = [
    ...new Set(items.map((i) => i.styleNumber).filter((s): s is string => Boolean(s))),
  ];

  const cust = (opts.customerItemNo ?? "").trim();
  if (cust) {
    const match = items.find((i) => i.customerItemNo === cust);
    if (match) return { kind: "customerItemNo", items: [match], poStyleNumbers };
  }

  const keys = styleKeys(opts.styleNumber ?? "");
  // The consignment / article-group code (text99__1, e.g. "ILC01989") is how a
  // multi-style Contrast PO keys its Barcodes sections when the header carries
  // NO style number — "ILC01989 - Fleece pants" for a style Monday-named
  // "IL62778I+IL62779I". Add it as an extra section key. Gated to code-shaped
  // values (a letter AND a digit) so a bare number / free-text value can't
  // widen the match; the PO side already never emits bare-number styleNumbers.
  const cc = norm(opts.consignmentCode ?? "");
  if (cc && /[a-z]/.test(cc) && /[0-9]/.test(cc)) keys.add(cc);
  if (keys.size > 0) {
    const matches = items.filter((i) => i.styleNumber && keys.has(norm(i.styleNumber)));
    if (matches.length > 0) return { kind: "styleNumber", items: matches, poStyleNumbers };
  }

  // Name-in-description tier — only reached when style-number matching found
  // nothing. Match the (normalised) style name against the section headers;
  // use it ONLY when it pins exactly one section, so it can never silently
  // pull in a second style's EANs (that stays the reject/all path below).
  const nameKey = norm(opts.styleNumber ?? "");
  if (nameKey.length >= 5) {
    const named = items.filter((i) => i.description && norm(i.description).includes(nameKey));
    if (named.length === 1) return { kind: "styleNumber", items: named, poStyleNumbers };
  }

  // No match. Reject ONLY when ALL of:
  //   • the PO has MULTIPLE style sections (genuinely ambiguous — picking the
  //     wrong one would write another style's EANs), and
  //   • this style is a single, real style number we'd expect to find there.
  // A single-section PO is unambiguous → take it. A bundle / descriptive /
  // assortment-coded style can't be matched by style number at all, so it also
  // falls through to take-all — exactly the pre-change behaviour, no regression.
  if (poStyleNumbers.length > 1 && looksLikeStyleNumber(opts.styleNumber ?? "")) {
    return { kind: "reject", items: [], poStyleNumbers };
  }

  return { kind: "all", items, poStyleNumbers };
}

// The carton / assortment EAN for the selected section(s). Prefer the section's
// own assortment EAN, but some POs put it on a SEPARATE pack/assortment line (a
// 2-pack wrapper bundling several styles) that no style number matches — so
// fall back to any other item's assortment EAN. This keeps the carton on
// bundle POs identical to the pre-style-number behaviour; clean per-style POs
// (each section has its own ASS row) always hit the first branch.
export function cartonEanFor(selected: PoItem[], all: PoItem[]): string | null {
  return (
    selected.map((i) => i.assortmentEans[0]).find(Boolean) ??
    all
      .filter((i) => !selected.includes(i))
      .map((i) => i.assortmentEans[0])
      .find(Boolean) ??
    null
  );
}

// Flatten the selected sections' variants, tagging each with ITS OWN section's
// carton EAN. A multi-colourway style is listed as one section per colour, each
// with its own carton, so the carton must travel with the colour rather than
// collapse to the first section's (what a single cartonEanFor would do).
export function variantsWithSectionCarton(
  items: PoItem[],
): Array<PoVariant & { cartonEan: string | null }> {
  return items.flatMap((i) =>
    i.variants.map((v) => ({ ...v, cartonEan: i.assortmentEans[0] ?? null })),
  );
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
