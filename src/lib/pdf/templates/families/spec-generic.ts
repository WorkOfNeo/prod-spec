import type { PrintSpec, PartSpec, FieldSpec, FieldKey } from "@/print-specs/shared/types";
import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { escapeHtml, htmlDocument, tFor } from "../base";
import { renderBarcodeDataUrl } from "../../barcode";
import { loadWashcareSymbols, getWashcareSymbol, type WashcareSymbolMap } from "../../washcare-symbols";
import { loadCertificates, type CertificateMap } from "../../certificates";
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
// Generic spec-driven renderer — serves every dynamic print spec whose
// family has no bespoke renderer yet (wash care labels, price/polybag/
// barcode/tag stickers, info areas, neckprints, …).
//
// It renders the spec literally: one PDF page per spec PART per size
// (mixed page sizes via CSS named pages), and inside each page one block
// per FIELD in spec order. Field content resolves exactly like the
// hand-built templates do — composition translations and "Made in
// <country>" runs from the Translation board, care instructions from the
// DB-managed care-label lines, wash symbols and certificates from their
// libraries, EAN-13s through bwip-js.
//
// Layout fidelity is intentionally "correct content, plain typography":
// every family can later graduate to a bespoke renderer (like
// care-label-square-3label) without touching specs, seeds, or variant
// keys. Parts with 0×0 dimensions (size-changeable info areas) render at
// the ProdSpec output's configured mm size — the one case where the
// `dims` argument wins.
// =====================================================

type LangSpec = { code: string; label: string };

const toLangSpecs = (langs: readonly string[] | undefined): LangSpec[] =>
  (langs ?? []).map((l) => ({ code: l.toLowerCase(), label: l.toUpperCase() }));

// Default one-line formats for the simple value fields. A few specs carry
// distinctive wording from their reference PDFs — see SPEC_TWEAKS.
const LINE_FORMATS: Partial<Record<FieldKey, (v: string) => string>> = {
  customerItemNo: (v) => v,
  customerOrderNumber: (v) => `Order nr : ${v}`,
  batchNo: (v) => `Batch no. ${v}`,
  articleNo: (v) => `Article no. ${v}`,
  prodNumber: (v) => `Prod. Nr: ${v}`,
  styleNumber: (v) => v,
  description: (v) => v,
  qtyPerCarton: (v) => `${v} pcs`,
  lotNo: (v) => `Lot: ${v}`,
  campaignWeek: (v) => v,
  poNumber: (v) => `PO No. ${v}`,
};

type SpecTweaks = {
  sizesHeading?: string;
  sizeRangeCaption?: string[];
  format?: Partial<Record<FieldKey, (v: string) => string>>;
};

// Presentation wording the typed spec fields can't carry (it lives in the
// specs' prose notes). Keyed by spec id; everything else uses the defaults.
const SPEC_TWEAKS: Record<string, SpecTweaks> = {
  "sok-license-price-sticker": { format: { styleNumber: (v) => `Model no.${v}` } },
  "sok-private-label-price-sticker": { format: { styleNumber: (v) => `Model no.${v}` } },
  "dollarstore-license-polybag-sticker-layout": {
    format: { customerItemNo: (v) => `Art. ${v}`, qtyPerCarton: (v) => `Inner box: ${v} pair` },
  },
  "dollarstore-private-label-polybag-sticker": {
    format: { customerItemNo: (v) => `Art. ${v}`, qtyPerCarton: (v) => `Inner box: ${v} pair` },
  },
  "tokmanni-license-polybag-sticker-layout": {
    sizesHeading: "KOKO/STORLEK:",
    sizeRangeCaption: ["Tästä tuotteesta saatavana koot:", "Storlekar för denna produkt:"],
  },
  "tokmanni-private-label-polybag-sticker": {
    sizesHeading: "KOKO/STORLEK:",
    sizeRangeCaption: ["Tästä tuotteesta saatavana koot:", "Storlekar för denna produkt:"],
  },
  "rema-1000-license-wash-care-label": { format: { retailPrice: (v) => `Pris Kr. ${v}` } },
  "rema-1000-private-label-wash-care-label": { format: { retailPrice: (v) => `Pris Kr. ${v}` } },
  "rema-1000-license-info-area": { format: { retailPrice: (v) => `Pris Kr. ${v}` } },
  "rema-1000-private-label-info-area": { format: { retailPrice: (v) => `Pris Kr. ${v}` } },
};

// Print-house brand block (single Contrast tenant) — rendered wherever a
// spec declares a `supplierAddress` field. Kaufland's reference wraps it
// in a multilingual "Hersteller / Výrobce / …" caption; v1 renders the
// plain Contrast block for every member.
const BRAND_BLOCK = {
  wordmarkSvg: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" preserveAspectRatio="xMidYMid meet">
      <text x="100" y="32" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="26" letter-spacing="2" fill="#000">CONTRAST</text>
      <text x="100" y="46" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="6" letter-spacing="6" fill="#000">COMPANY</text>
    </svg>`,
  address: "Rudolfgårdsvej 6A - 8260 Viby J - DK",
  contact: "www.contrast.dk/info@contrast.dk",
};

const partClass = (part: PartSpec) => `pg-${part.id.replace(/[^a-z0-9-]/gi, "-")}`;

export function makeGenericSpecRenderer(
  spec: PrintSpec,
): (style: StyleData, dims: OutputDims) => Promise<string> {
  const parts = spec.parts ?? [];
  const tweaks = SPEC_TWEAKS[spec.id] ?? {};

  return async function renderGenericSpecHtml(
    style: StyleData,
    dims: OutputDims,
  ): Promise<string> {
    const [symbolMap, certMap, dict, allCareLabels] = await Promise.all([
      loadWashcareSymbols(),
      loadCertificates(),
      loadTranslationDictionary(),
      loadCareLabels(),
    ]);

    const present: PresentSymbol[] = style.washSymbols.map((token) => {
      const resolved = getWashcareSymbol(symbolMap, token);
      return resolved
        ? { code: resolved.code, action: resolved.action, restrictive: resolved.restrictive }
        : { code: token, action: null, restrictive: false };
    });
    const careLabels = allCareLabels.filter((l) => isCareLabelVisible(l, present));

    // Resolved page size per part: the spec's mm callouts, except
    // size-changeable parts (0×0) which take the ProdSpec output's dims.
    const partDims = (part: PartSpec) =>
      part.dimensions.widthMm > 0 && part.dimensions.heightMm > 0
        ? part.dimensions
        : { widthMm: dims.widthMm, heightMm: dims.heightMm };

    // ProdSpec-selected languages override the spec's reference language
    // sets. The care-instruction split collapses onto the FIRST part that
    // carries careInstructions; later care parts go blank (same semantics
    // as care-label-02 / the F3 family renderer).
    const selected = toLangSpecs(style.outputLanguages ?? []);
    const useSelection = selected.length > 0;

    const sizesToRender =
      style.sizes.length > 0 ? style.sizes : [{ label: "—", ean13: "0000000000000" } as const];

    const ctx: RenderCtx = {
      spec,
      style,
      dict,
      symbolMap,
      certMap,
      careLabels,
      tweaks,
      selected,
      useSelection,
    };

    const pageBlocks: string[] = [];
    for (const size of sizesToRender) {
      let careSeen = false;
      for (const part of parts) {
        const pageHeightMm = partDims(part).heightMm;
        const blocks: string[] = [];
        for (const field of part.fields) {
          const isCare = field.key === "careInstructions";
          const suppressCare = isCare && ctx.useSelection && careSeen;
          if (isCare) careSeen = true;
          if (suppressCare) continue;
          blocks.push(await renderField(field, size, ctx, pageHeightMm));
        }
        const content = blocks.filter(Boolean).join("\n");
        // .fit is the scale-to-fit target: the .page box itself must stay
        // at the exact die size (the forced page break slices at its edge),
        // so the zoom is applied to this inner wrapper only.
        pageBlocks.push(`
    <div class="page ${partClass(part)}">
      <div class="fit">
      ${content || `<div class="empty-page">${escapeHtml(part.id)} · no printable data for this style</div>`}
      </div>
    </div>`);
      }
    }

    // Named @page rule per part so one PDF can mix die sizes.
    const firstDims = parts.length > 0 ? partDims(parts[0]) : { widthMm: dims.widthMm, heightMm: dims.heightMm };
    // Explicit mm width AND height per part: the width makes the on-load
    // measurement (browser viewport) wrap text exactly like the print
    // fragmentainer will, so the scale-to-fit pass sees the real overflow.
    const partCss = parts
      .map((part) => {
        const d = partDims(part);
        return `
        @page ${partClass(part)} { size: ${d.widthMm}mm ${d.heightMm}mm; }
        .${partClass(part)} { page: ${partClass(part)}; width: ${d.widthMm}mm; height: ${d.heightMm}mm; }`;
      })
      .join("\n");

    // Scale-to-fit: the dense reference labels are micro-print (9-language
    // blocks on a 35×66 die). When a page's content overruns its fixed die
    // height, zoom it down until it fits — Chromium runs this before the
    // PDF snapshot (renderPdf waits for load + fonts), and the on-screen
    // preview iframes run it too. Zoom triggers reflow, so iterate a few
    // times toward the fitting ratio.
    const fitScript = `
    <script>
      // Run at window load (not parse time) so barcode/symbol images have
      // their real heights; renderPdf snapshots after load + fonts.ready.
      // The zoom goes on the inner .fit wrapper — the .page box must keep
      // the exact die size, since the forced page break slices at its
      // edge. Zooming .fit changes the content extent measured on .page,
      // so the ratio genuinely converges (×0.98 safety against rounding).
      window.addEventListener("load", () => {
        for (const el of document.querySelectorAll(".page")) {
          const inner = el.querySelector(".fit");
          if (!inner) continue;
          for (let i = 0; i < 5; i++) {
            const fit = el.clientHeight / el.scrollHeight;
            if (fit >= 1) break;
            const current = parseFloat(inner.style.zoom || "1");
            inner.style.zoom = String(Math.max(0.25, current * fit * 0.98));
          }
        }
      });
    </script>`;

    return htmlDocument({
      title: `${spec.customer} · ${spec.businessArea} — ${spec.printType} (${spec.id})`,
      pageSize: { kind: "mm" as const, widthMm: firstDims.widthMm, heightMm: firstDims.heightMm },
      body: pageBlocks.join("\n") + fitScript,
      barcodeFont: style.barcodeFont,
      extraCss: `
        ${partCss}
        .page {
          padding: 2.5mm 2.5mm;
          font-size: 6pt;
          line-height: 1.25;
          page-break-after: always;
        }
        /* :last-of-type, not :last-child — the fit <script> tag follows
           the final page inside <body>. */
        .page:last-of-type { page-break-after: auto; }
        .fit { display: flex; flex-direction: column; height: 100%; }
        .size-heading { font-size: 6pt; letter-spacing: 0.04em; text-align: center; }
        .size-label { margin-top: 0.8mm; font-size: 6.5pt; font-weight: 700; text-align: center; }
        .size-range-caption { margin-top: 1mm; font-size: 5pt; text-align: center; }
        .size-range { font-size: 5.5pt; font-weight: 600; text-align: center; }
        .value-line { margin-top: 1mm; font-size: 5.5pt; text-align: center; }
        .price-line { margin-top: 1.2mm; font-size: 7pt; font-weight: 700; text-align: center; }
        .po-line { margin-top: 1.5mm; font-size: 6pt; font-weight: 600; }
        .barcode-block { margin-top: 1.5mm; width: 100%; }
        /* max-width + auto dims preserve the PNG's aspect ratio; width:100%
           with a max-height cap used to squash bars and digits together. */
        .barcode-block img { display: block; max-width: 100%; width: auto; height: auto; margin: 0 auto; }
        .barcode-missing {
          font-size: 5pt; color: #a00; text-align: center;
          padding: 1mm; border: 0.15mm dashed #a00; border-radius: 0.5mm;
        }
        .composition-original { font-weight: 700; margin: 1mm 0 0.8mm; line-height: 1.2; }
        .lang-rows { display: flex; flex-direction: column; gap: 0.4mm; }
        .lang-row { display: flex; gap: 1mm; align-items: baseline; }
        .lang-row .lang { width: 5mm; flex-shrink: 0; font-weight: 600; color: #000; }
        .lang-row .text { flex: 1; }
        .care-rows { margin-top: 1mm; gap: 0.8mm; }
        .care-rows .text { text-align: justify; hyphens: auto; }
        .symbols {
          margin-top: 1.5mm;
          display: flex; flex-wrap: nowrap; gap: 1mm;
          justify-content: center; align-items: center;
        }
        .symbols img { width: 4.5mm; height: 4.5mm; object-fit: contain; flex-shrink: 0; }
        .symbols .missing {
          font-size: 3.5pt; line-height: 1.1; max-width: 8mm;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          padding: 0 0.5mm; border: 0.15mm dashed #aaa; border-radius: 0.5mm; color: #999;
        }
        .made-in-block { margin-top: 1.5mm; }
        .made-in-run { font-size: 5.5pt; line-height: 1.2; text-align: justify; }
        .brand-block { margin-top: auto; padding-top: 1.5mm; text-align: center; }
        .brand-block .wordmark { width: 22mm; margin: 0 auto 1mm; }
        .brand-block .wordmark svg { width: 100%; height: auto; display: block; }
        .brand-block .addr { font-size: 4.5pt; line-height: 1.2; }
        .cert-logo { max-width: 12mm; max-height: 8mm; object-fit: contain; margin: 1mm auto 0; display: block; }
        .empty-page {
          display: flex; align-items: center; justify-content: center;
          height: 100%; color: #ccc; font-size: 4pt; font-style: italic; text-align: center;
        }
      `,
    });
  };
}

// -----------------------------------------------------
// Per-field rendering
// -----------------------------------------------------
type RenderCtx = {
  spec: PrintSpec;
  style: StyleData;
  dict: TranslationDictionary;
  symbolMap: WashcareSymbolMap;
  certMap: CertificateMap;
  careLabels: CareLabel[];
  tweaks: SpecTweaks;
  selected: LangSpec[];
  useSelection: boolean;
};

async function renderField(
  field: FieldSpec,
  size: { label: string; ean13: string },
  ctx: RenderCtx,
  pageHeightMm: number,
): Promise<string> {
  const { style, dict, tweaks } = ctx;
  const langs = ctx.useSelection ? ctx.selected : toLangSpecs(field.languages);

  switch (field.key) {
    case "sizes":
      return `
        <div class="size-heading">${escapeHtml(tweaks.sizesHeading ?? "Size / Stl / Str")}</div>
        <div class="size-label">${escapeHtml(size.label)}</div>`;

    case "sizeRange": {
      const range = style.sizes.map((s) => s.label).filter(Boolean).join("-");
      if (!range) return "";
      const caption = (tweaks.sizeRangeCaption ?? [])
        .map((line) => `<div class="size-range-caption">${escapeHtml(line)}</div>`)
        .join("");
      return `${caption}<div class="size-range">${escapeHtml(range)}</div>`;
    }

    case "ean13":
      return renderEanBlock(size, pageHeightMm);

    case "composition":
      return compositionBlock(style, dict, langs);

    case "careInstructions":
      return careBlock(style, ctx.careLabels, dict, langs);

    case "washCareSymbols":
      return symbolsBlock(style, ctx.symbolMap);

    case "countryOfOrigin":
      return madeInBlock(style.countryOfOrigin, dict, langs.map((l) => l.code));

    case "supplierAddress":
      return `
        <div class="brand-block">
          <div class="wordmark">${BRAND_BLOCK.wordmarkSvg}</div>
          <div class="addr">${escapeHtml(BRAND_BLOCK.address)}</div>
          <div class="addr">${escapeHtml(BRAND_BLOCK.contact)}</div>
        </div>`;

    case "retailPrice": {
      if (!style.price) return "";
      const amount = style.price.amount.toFixed(2).replace(".", ",");
      const fmt = tweaks.format?.retailPrice;
      const text = fmt ? fmt(amount) : `${amount} ${style.price.currency}`;
      return `<div class="price-line">${escapeHtml(text)}</div>`;
    }

    case "oekoTexLogo": {
      // Render the Oeko-Tex logo only when the style actually declares an
      // OEKO certificate with artwork in the library ("Add Oeko tex logo
      // here if required").
      const name = (style.certificates ?? []).find((c) => /oeko/i.test(c));
      const resolved = name ? ctx.certMap.get(name.trim().toLowerCase()) : undefined;
      return resolved?.dataUrl
        ? `<img class="cert-logo" src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" />`
        : "";
    }

    // Not rendered generically: composition2 lives on static carton artwork
    // only, and ean128 is only declared by the carton-marking-netto-dk
    // family, whose bespoke renderer draws the whole label itself.
    case "composition2":
    case "ean128":
      return "";

    default:
      return simpleLine(field.key, style, tweaks);
  }
}

function simpleLine(key: FieldKey, style: StyleData, tweaks: SpecTweaks): string {
  const value = valueFor(key, style);
  if (!value) return "";
  const fmt = tweaks.format?.[key] ?? LINE_FORMATS[key] ?? ((v: string) => v);
  const cls = key === "poNumber" ? "po-line" : "value-line";
  return `<div class="${cls}">${escapeHtml(fmt(value))}</div>`;
}

function valueFor(key: FieldKey, style: StyleData): string | undefined {
  switch (key) {
    case "customerItemNo":
      return style.customerItemNo;
    // The customer's article number under Rema's label wording.
    case "articleNo":
      return style.customerItemNo;
    case "customerOrderNumber":
      return style.customerOrderNo;
    case "batchNo":
      return style.batchNo;
    case "prodNumber":
      return style.prodNumber;
    case "styleNumber":
      return style.styleNumber;
    case "description":
      return style.description;
    case "qtyPerCarton":
      return style.carton.outerVE > 0 ? String(style.carton.outerVE) : undefined;
    case "lotNo":
      return style.carton.lot || undefined;
    case "campaignWeek":
      return style.campaignWeek;
    case "poNumber":
      return style.poNumber;
    default:
      return undefined;
  }
}

async function renderEanBlock(
  size: { label: string; ean13: string },
  pageHeightMm: number,
): Promise<string> {
  if (size.ean13 === "0000000000000") {
    return `<div class="barcode-block"><div class="barcode-missing">No valid EAN for ${escapeHtml(size.label)}</div></div>`;
  }
  // Cap the bars to roughly half the die height so tiny parts (10 mm fold
  // strips, 21 mm neckprints) keep the barcode on their own page instead
  // of overflowing onto an extra one.
  const maxHeightMm = Math.max(3, Math.min(12, pageHeightMm * 0.5)).toFixed(1);
  try {
    // Default EAN-13 text placement (digits between the extended guard
    // bars, first digit to the left) — see barcode.ts DEFAULTS.
    const url = await renderBarcodeDataUrl(size.ean13, {
      scale: 3,
      height: 10,
    });
    return `<div class="barcode-block"><img style="max-height: ${maxHeightMm}mm" src="${url}" alt="${escapeHtml(size.ean13)}" /></div>`;
  } catch {
    return `<div class="barcode-block"><div class="barcode-missing">EAN ${escapeHtml(size.ean13)} — invalid</div></div>`;
  }
}

function compositionBlock(
  style: StyleData,
  dict: TranslationDictionary,
  langs: LangSpec[],
): string {
  const originalText = tFor(style.composition, "en") || style.composition[0]?.text || "";
  const nonEnLangs = langs.filter(({ code }) => code !== "en");
  const wantsEnglish = langs.length === 0 || langs.some(({ code }) => code === "en");
  // Single-language blocks print plain, like the references do ("100%
  // Bomuld" on the Danish-only info areas — no "DA :" flag).
  const solo = !wantsEnglish && nonEnLangs.length === 1;
  const rows = nonEnLangs
    .map(({ code, label }) => {
      const entered = tFor(style.composition, code);
      const translated = originalText
        ? translateComposition(dict, originalText, code)
        : { text: "", changed: false };
      const text = entered || translated.text;
      if (!text || (!entered && !translated.changed)) return "";
      if (solo) return `<div class="composition-original">${escapeHtml(text)}</div>`;
      return `
      <div class="lang-row">
        <span class="lang">${label} :</span>
        <span class="text">${escapeHtml(text)}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
  // The bold English source line prints only when the language set includes
  // EN (or declares no languages at all) — a Danish-only info area must not
  // lead with English. It comes back as the fallback when no language row
  // resolved, so the print never loses the composition entirely.
  const originalRow =
    originalText && (wantsEnglish || !rows)
      ? `<div class="composition-original">${escapeHtml(originalText)}</div>`
      : "";
  if (!originalRow && !rows) return "";
  if (solo) return `${originalRow}${rows}`;
  return `${originalRow}${rows ? `<div class="lang-rows">${rows}</div>` : ""}`;
}

function careBlock(
  style: StyleData,
  labels: CareLabel[],
  dict: TranslationDictionary,
  langs: LangSpec[],
): string {
  const override = style.careInstructionsByLang ?? {};
  // Single-language blocks print without the language flag, matching the
  // references (the Danish-only Coop care labels carry plain Danish text).
  const solo = langs.length === 1;
  const rows = langs
    .map(({ code, label }) => {
      const composed = labels
        .map((l) => translatePhrase(dict, l.sourceText, code).trim())
        .filter(Boolean)
        .join(" / ");
      const text = (override[code]?.trim() || composed).trim();
      if (!text) return "";
      if (solo) return `<div class="text">${escapeHtml(text)}</div>`;
      return `
      <div class="lang-row">
        <span class="lang">${label} :</span>
        <span class="text">${escapeHtml(text)}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
  return rows ? `<div class="lang-rows care-rows">${rows}</div>` : "";
}

function symbolsBlock(style: StyleData, symbolMap: WashcareSymbolMap): string {
  const symbols = style.washSymbols
    .map((token) => {
      const resolved = getWashcareSymbol(symbolMap, token);
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      const label = resolved?.name ?? token;
      return `<span class="missing">${escapeHtml(label)}</span>`;
    })
    .join("");
  return symbols ? `<div class="symbols">${symbols}</div>` : "";
}

function madeInBlock(
  rawCountry: string | undefined,
  dict: TranslationDictionary,
  langCodes: ReadonlyArray<string>,
): string {
  if (!rawCountry || !rawCountry.trim()) return "";
  const country = rawCountry.trim();
  const english = `Made in ${country}`;
  const seen = new Set<string>();
  const phrases = (langCodes.length > 0 ? langCodes : ["en"])
    .map((code) => translatePhrase(dict, english, code).trim())
    .filter((p) => p && !seen.has(p) && (seen.add(p), true));
  const text = phrases.length > 0 ? phrases.join(" / ") : english;
  return `<div class="made-in-block"><div class="made-in-run">${escapeHtml(text)}</div></div>`;
}
