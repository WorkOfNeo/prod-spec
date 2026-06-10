import type { PrintSpec, PartSpec, FieldSpec, FieldKey, Lang } from "@/print-specs/shared/types";
import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { escapeHtml, htmlDocument, tFor } from "../base";
import { renderBarcodeDataUrl } from "../../barcode";
import { loadWashcareSymbols, type WashcareSymbolMap } from "../../washcare-symbols";
import {
  loadTranslationDictionary,
  translatePhrase,
  translateComposition,
  type TranslationDictionary,
} from "@/lib/translations/lookup";
import {
  loadCareLabels,
  isCareLabelVisible,
  type CareLabel,
  type PresentSymbol,
} from "@/lib/care-labels";

// =====================================================
// Family renderer: `care-label-square-3label` (brief F3).
//
// One renderer for the whole family — Coop DK License, Europris PL,
// Ge-kås (License + PL) and Runsven PL. Everything member-specific is
// read from the member's print spec (src/print-specs/<customer>/…):
//   • per-part mm dimensions (label 1 is 35×45 — except Runsven's 35×90)
//   • which fields label 1 carries (item no? campaign week? Swedish COO
//     + customer address block?)
//   • the exact language list per text block, incl. the care-instruction
//     split across label 2 BACK / label 3 FRONT
//   • whether label 3 BACK prints the Contrast brand block
//
// Physical product per size: LABEL 1 (single-sided size/EAN front label)
// + LABELS 2–3 (35×90, printed front/back). The PDF carries five pages
// per size — one per print pass — and mixes page sizes via CSS named
// pages (`@page pg-label1` / `@page pg-sheet`; the renderer passes
// preferCSSPageSize so Chromium honours both).
//
// Content logic (composition translations, DB-managed care lines,
// "Made in <country>" runs) intentionally mirrors care-label-02 — that
// template is the hand-built ancestor of this family. Kept self-contained
// so the legacy generic and the spec-driven family can diverge freely.
// =====================================================

// Presentation minutiae the typed spec fields can't carry (they live in
// the spec's prose notes): how each customer prefixes the article number
// on label 1, and Runsven's customer address block. Keyed by spec id.
const ITEM_NO_PREFIX: Record<string, string> = {
  "coop-dk-license-62897-care-label-layout": "",
  "europris-private-label-62916-care-label-layout": "Art No.: ",
  "runsven-private-label-62951-care-label-layout": "Item No : ",
};

const CUSTOMER_ADDRESS_LINES: Record<string, string[]> = {
  // Label 1 footer per the Runsven reference PDF ("Tillverkad i India för
  // Runsven AB" renders above these via the translation dictionary).
  "runsven-private-label-62951-care-label-layout": [
    "Runsven AB",
    "Box 143, 596 23 Skänninge",
    "Tlf.: +46(0)771 202 202,",
    "kundtjanst@runsvengruppen.com",
  ],
};

// Print-house brand block — same artwork as care-label-02 (the single
// Contrast tenant). Rendered on label 3 BACK when the spec declares a
// `supplierAddress` field there.
const BRAND_BLOCK = {
  wordmarkSvg: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" preserveAspectRatio="xMidYMid meet">
      <text x="100" y="32" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="26" letter-spacing="2" fill="#000">CONTRAST</text>
      <text x="100" y="46" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="6" letter-spacing="6" fill="#000">COMPANY</text>
    </svg>`,
  address: "Rudolfgårdsvej 6A - 8260 Viby J - DK",
  contact: "www.contrast.dk/info@contrast.dk",
};

type LangSpec = { code: string; label: string };

const toLangSpecs = (langs: readonly Lang[] | undefined): LangSpec[] =>
  (langs ?? []).map((l) => ({ code: l.toLowerCase(), label: l }));

const findPart = (spec: PrintSpec, id: string): PartSpec | undefined =>
  spec.parts?.find((p) => p.id === id);

const findField = (part: PartSpec | undefined, key: FieldKey): FieldSpec | undefined =>
  part?.fields.find((f) => f.key === key);

export function makeCareLabelSquare3LabelRenderer(
  spec: PrintSpec,
): (style: StyleData, dims: OutputDims) => Promise<string> {
  // ---- resolve the family knobs from the spec, once ----
  const label1Part = findPart(spec, "label1");
  const sheetPart = findPart(spec, "label2-front");
  const label1 = label1Part?.dimensions ?? { widthMm: 35, heightMm: 45 };
  const sheet = sheetPart?.dimensions ?? { widthMm: 35, heightMm: 90 };

  const hasItemNo = !!findField(label1Part, "customerItemNo");
  const hasCampaignWeek = !!findField(label1Part, "campaignWeek");
  const label1Coo = findField(label1Part, "countryOfOrigin");
  const itemNoPrefix = ITEM_NO_PREFIX[spec.id] ?? "";
  const addressLines = CUSTOMER_ADDRESS_LINES[spec.id] ?? [];

  const compositionLangs = toLangSpecs(findField(sheetPart, "composition")?.languages);
  const careTopLangs = toLangSpecs(
    findField(findPart(spec, "label2-back"), "careInstructions")?.languages,
  );
  const careBottomLangs = toLangSpecs(
    findField(findPart(spec, "label3-front"), "careInstructions")?.languages,
  );
  const label3Back = findPart(spec, "label3-back");
  const cooLangCodes = toLangSpecs(findField(label3Back, "countryOfOrigin")?.languages).map(
    (l) => l.code,
  );
  const hasBrandBlock = !!findField(label3Back, "supplierAddress");
  const hasPoNumber = !!findField(label3Back, "poNumber");

  // `dims` is ignored on purpose: this is a multi-part artifact and the
  // per-part page sizes come from the print spec. The single mm pair on
  // the ProdSpec output entry can't describe two die sizes.
  return async function renderSquare3LabelHtml(style: StyleData): Promise<string> {
    const [symbolMap, dict, allCareLabels] = await Promise.all([
      loadWashcareSymbols(),
      loadTranslationDictionary(),
      loadCareLabels(),
    ]);

    // Care lines visible for this style's wash symbols (same selection
    // logic as care-label-02 — see src/lib/care-labels).
    const present: PresentSymbol[] = style.washSymbols.map((token) => {
      const resolved = symbolMap.get(token);
      return resolved
        ? { code: resolved.code, action: resolved.action, restrictive: resolved.restrictive }
        : { code: token, action: null, restrictive: false };
    });
    const careLabels = allCareLabels.filter((l) => isCareLabelVisible(l, present));

    // ProdSpec-selected languages override the spec's reference split:
    // everything moves to label 2 BACK and the label 3 FRONT continuation
    // empties (mirrors care-label-02's resolveCareLangs behaviour).
    const selected = (style.outputLanguages ?? []).map((code) => ({
      code,
      label: code.toUpperCase(),
    }));
    const careTop = selected.length > 0 ? selected : careTopLangs;
    const careBottom = selected.length > 0 ? [] : careBottomLangs;
    const compLangs = selected.length > 0 ? selected : compositionLangs;
    const cooCodes = selected.length > 0 ? selected.map((l) => l.code) : cooLangCodes;

    const sizesToRender =
      style.sizes.length > 0 ? style.sizes : [{ label: "—", ean13: "0000000000000" } as const];

    const sizeBlocks = await Promise.all(
      sizesToRender.map(async (size) => {
        const label1Page = await renderLabel1Page(size, style, dict, {
          hasItemNo,
          hasCampaignWeek,
          itemNoPrefix,
          cooLang: label1Coo ? toLangSpecs(label1Coo.languages)[0]?.code : undefined,
          addressLines,
        });
        return [
          label1Page,
          pageCompositionAndSymbols(style, symbolMap, dict, compLangs),
          pageCare(style, careLabels, dict, careTop, "Label 2 BACK"),
          pageCareBottom(style, careLabels, dict, careBottom),
          pageCooPoBrand(style, dict, cooCodes, { hasBrandBlock, hasPoNumber }),
        ].join("\n");
      }),
    );

    return htmlDocument({
      title: `${spec.customer} · ${spec.businessArea} — care label (${spec.id})`,
      // Generic @page = the dominant 35×90 sheet; label 1 overrides via
      // the named rule below. Margins stay 0 from the generic rule.
      pageSize: { kind: "mm" as const, widthMm: sheet.widthMm, heightMm: sheet.heightMm },
      body: sizeBlocks.join("\n"),
      barcodeFont: style.barcodeFont,
      extraCss: `
        @page pg-label1 { size: ${label1.widthMm}mm ${label1.heightMm}mm; }
        @page pg-sheet { size: ${sheet.widthMm}mm ${sheet.heightMm}mm; }
        .page {
          padding: 3mm 2.5mm;
          font-size: 6pt;
          line-height: 1.2;
          display: flex;
          flex-direction: column;
          page-break-after: always;
        }
        .page:last-child { page-break-after: auto; }
        .pg-label1 { page: pg-label1; height: ${label1.heightMm}mm; align-items: center; }
        .pg-sheet { page: pg-sheet; height: ${sheet.heightMm}mm; }
        .size-heading { margin-top: 1mm; font-size: 6pt; letter-spacing: 0.04em; }
        .size-label { margin-top: 1mm; font-size: 6.5pt; font-weight: 700; line-height: 1; }
        .item-no { margin-top: 1.2mm; font-size: 5.5pt; }
        .campaign-week { margin-top: 0.8mm; font-size: 5pt; color: #000; }
        .l1-barcode { margin-top: 2mm; width: 100%; }
        .l1-barcode img { display: block; width: 100%; height: auto; max-height: 13mm; }
        .l1-coo { margin-top: auto; text-align: center; font-size: 4.8pt; line-height: 1.3; }
        .l1-coo .made-in { font-weight: 600; }
        .barcode-missing {
          font-size: 5pt; color: #a00; text-align: center;
          padding: 1mm; border: 0.15mm dashed #a00; border-radius: 0.5mm;
        }
        .composition-original { font-weight: 700; margin-bottom: 0.8mm; line-height: 1.2; }
        .lang-rows { display: flex; flex-direction: column; gap: 0.4mm; }
        .lang-row { display: flex; gap: 1mm; align-items: baseline; }
        .lang-row .lang { width: 5mm; flex-shrink: 0; font-weight: 600; color: #000; }
        .lang-row .text { flex: 1; }
        .care-rows { gap: 0.8mm; }
        .care-rows .text { text-align: justify; hyphens: auto; }
        .symbols {
          margin-top: auto; padding-top: 2mm;
          display: flex; flex-wrap: nowrap; gap: 1mm;
          justify-content: center; align-items: center;
        }
        .symbols img { width: 4.5mm; height: 4.5mm; object-fit: contain; flex-shrink: 0; }
        .symbols .missing {
          font-size: 3.5pt; line-height: 1.1; max-width: 8mm;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          padding: 0 0.5mm; border: 0.15mm dashed #aaa; border-radius: 0.5mm; color: #999;
        }
        .made-in-block { margin-top: 2.5mm; }
        .made-in-run { font-size: 5.5pt; line-height: 1.2; text-align: justify; }
        .po-line { margin-top: 2mm; font-size: 6pt; font-weight: 600; }
        .brand-block { margin-top: 2mm; text-align: center; }
        .brand-block .wordmark { width: 22mm; margin: 0 auto 1mm; }
        .brand-block .wordmark svg { width: 100%; height: auto; display: block; }
        .brand-block .addr { font-size: 4.5pt; line-height: 1.2; }
        .empty-page {
          display: flex; align-items: center; justify-content: center;
          height: 100%; color: #ccc; font-size: 4pt; font-style: italic;
        }
      `,
    });
  };
}

// -----------------------------------------------------
// LABEL 1 — size / EAN-13 front label (one page per size)
// -----------------------------------------------------
async function renderLabel1Page(
  size: { label: string; ean13: string },
  style: StyleData,
  dict: TranslationDictionary,
  opts: {
    hasItemNo: boolean;
    hasCampaignWeek: boolean;
    itemNoPrefix: string;
    cooLang?: string;
    addressLines: string[];
  },
): Promise<string> {
  let barcodeHtml: string;
  if (size.ean13 === "0000000000000") {
    barcodeHtml = `<div class="barcode-missing">No valid EAN for ${escapeHtml(size.label)}</div>`;
  } else {
    try {
      const barcodeDataUrl = await renderBarcodeDataUrl(size.ean13, {
        scale: 3,
        height: 10,
        includetext: true,
        textxalign: "center",
      });
      barcodeHtml = `<img src="${barcodeDataUrl}" alt="${escapeHtml(size.ean13)}" />`;
    } catch {
      barcodeHtml = `<div class="barcode-missing">EAN ${escapeHtml(size.ean13)} — invalid</div>`;
    }
  }

  const itemNo =
    opts.hasItemNo && style.customerItemNo
      ? `<div class="item-no">${escapeHtml(opts.itemNoPrefix)}${escapeHtml(style.customerItemNo)}</div>`
      : "";
  const campaign =
    opts.hasCampaignWeek && style.campaignWeek
      ? `<div class="campaign-week">${escapeHtml(style.campaignWeek)}</div>`
      : "";

  // Runsven variant: Swedish "Made in <country>" phrase + the customer
  // address block, anchored to the label foot. The phrase resolves from
  // the Translation board (e.g. "Tillverkad i Indien"); the address lines
  // are fixed customer master data (see CUSTOMER_ADDRESS_LINES).
  let coo = "";
  if (opts.cooLang && opts.addressLines.length > 0) {
    const country = style.countryOfOrigin?.trim();
    const madeIn = country
      ? translatePhrase(dict, `Made in ${country}`, opts.cooLang).trim()
      : "";
    const madeInFor = madeIn
      ? `<div class="made-in">${escapeHtml(madeIn)} för ${escapeHtml(opts.addressLines[0])}</div>`
      : "";
    const rest = opts.addressLines
      .slice(1)
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join("");
    coo = `<div class="l1-coo">${madeInFor}${rest}</div>`;
  }

  return `
    <div class="page pg-label1">
      <div class="size-heading">Size / Stl / Str</div>
      <div class="size-label">${escapeHtml(size.label)}</div>
      ${itemNo}
      ${campaign}
      <div class="l1-barcode">${barcodeHtml}</div>
      ${coo}
    </div>`;
}

// -----------------------------------------------------
// LABEL 2 FRONT — composition + wash care symbols
// -----------------------------------------------------
function pageCompositionAndSymbols(
  style: StyleData,
  symbolMap: WashcareSymbolMap,
  dict: TranslationDictionary,
  langs: LangSpec[],
): string {
  const originalText = tFor(style.composition, "en") || style.composition[0]?.text || "";
  const originalRow = originalText
    ? `<div class="composition-original">${escapeHtml(originalText)}</div>`
    : "";

  // Operator-entered translation wins; otherwise the Translation board
  // translates the English composition. Skip languages that stay English
  // so the label never prints "PL : <English>" (same rule as care-label-02).
  const translationRows = langs
    .filter(({ code }) => code !== "en")
    .map(({ code, label }) => {
      const entered = tFor(style.composition, code);
      const translated = originalText
        ? translateComposition(dict, originalText, code)
        : { text: "", changed: false };
      const text = entered || translated.text;
      if (!text || (!entered && !translated.changed)) return "";
      return `
      <div class="lang-row">
        <span class="lang">${label} :</span>
        <span class="text">${escapeHtml(text)}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");

  const compositionBlock =
    originalRow || translationRows
      ? `<div class="composition">
          ${originalRow}
          ${translationRows ? `<div class="lang-rows">${translationRows}</div>` : ""}
        </div>`
      : `<div class="empty-page">No composition translations entered.</div>`;

  const symbols = style.washSymbols
    .map((token) => {
      const resolved = symbolMap.get(token);
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      const label = resolved?.name ?? token;
      return `<span class="missing">${escapeHtml(label)}</span>`;
    })
    .join("");

  return `
    <div class="page pg-sheet">
      ${compositionBlock}
      ${symbols ? `<div class="symbols">${symbols}</div>` : ""}
    </div>`;
}

// -----------------------------------------------------
// LABEL 2 BACK — care instructions, first language batch
// -----------------------------------------------------
function pageCare(
  style: StyleData,
  labels: CareLabel[],
  dict: TranslationDictionary,
  langs: LangSpec[],
  panelName: string,
): string {
  const rows = careLangRows(style, langs, labels, dict);
  if (!rows) {
    return `
      <div class="page pg-sheet">
        <div class="empty-page">
          ${escapeHtml(panelName)}: no care instructions to print. No care labels are
          visible for this style's wash symbols, or none are configured
          (see /settings/care-labels).
        </div>
      </div>`;
  }
  return `<div class="page pg-sheet"><div class="lang-rows care-rows">${rows}</div></div>`;
}

// -----------------------------------------------------
// LABEL 3 FRONT — care instruction continuation (FR / PL batch)
// -----------------------------------------------------
function pageCareBottom(
  style: StyleData,
  labels: CareLabel[],
  dict: TranslationDictionary,
  langs: LangSpec[],
): string {
  const rows = careLangRows(style, langs, labels, dict);
  if (!rows) {
    return `<div class="page pg-sheet"><div class="empty-page">Label 3 FRONT · intentionally blank</div></div>`;
  }
  return `<div class="page pg-sheet"><div class="lang-rows care-rows">${rows}</div></div>`;
}

// -----------------------------------------------------
// LABEL 3 BACK — "Made in <country>" run + PO number + brand block
// -----------------------------------------------------
function pageCooPoBrand(
  style: StyleData,
  dict: TranslationDictionary,
  langCodes: string[],
  opts: { hasBrandBlock: boolean; hasPoNumber: boolean },
): string {
  const madeIn = renderMadeInBlock(style.countryOfOrigin, dict, langCodes);
  const po =
    opts.hasPoNumber && style.poNumber
      ? `<div class="po-line">PO No. ${escapeHtml(style.poNumber)}</div>`
      : "";
  const brand = opts.hasBrandBlock
    ? `
    <div class="brand-block">
      <div class="wordmark">${BRAND_BLOCK.wordmarkSvg}</div>
      <div class="addr">${escapeHtml(BRAND_BLOCK.address)}</div>
      <div class="addr">${escapeHtml(BRAND_BLOCK.contact)}</div>
    </div>`
    : "";

  if (!madeIn && !po && !brand) {
    return `<div class="page pg-sheet"><div class="empty-page">Label 3 BACK · intentionally blank</div></div>`;
  }
  return `
    <div class="page pg-sheet">
      ${madeIn}
      ${po}
      ${brand}
    </div>`;
}

// -----------------------------------------------------
// Helpers (same content rules as care-label-02)
// -----------------------------------------------------
function careLangRows(
  style: StyleData,
  langs: LangSpec[],
  labels: CareLabel[],
  dict: TranslationDictionary,
): string {
  const override = style.careInstructionsByLang ?? {};
  return langs
    .map(({ code, label }) => {
      const composed = labels
        .map((l) => translatePhrase(dict, l.sourceText, code).trim())
        .filter(Boolean)
        .join(" / ");
      const text = (override[code]?.trim() || composed).trim();
      if (!text) return "";
      return `
      <div class="lang-row">
        <span class="lang">${label} :</span>
        <span class="text">${escapeHtml(text)}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
}

function renderMadeInBlock(
  rawCountry: string | undefined,
  dict: TranslationDictionary,
  langCodes: ReadonlyArray<string>,
): string {
  if (!rawCountry || !rawCountry.trim()) return "";
  const country = rawCountry.trim();
  const english = `Made in ${country}`;
  const seen = new Set<string>();
  const phrases = langCodes
    .map((code) => translatePhrase(dict, english, code).trim())
    .filter((p) => p && !seen.has(p) && (seen.add(p), true));
  const text = phrases.length > 0 ? phrases.join(" / ") : english;
  return `<div class="made-in-block"><div class="made-in-run">${escapeHtml(text)}</div></div>`;
}
