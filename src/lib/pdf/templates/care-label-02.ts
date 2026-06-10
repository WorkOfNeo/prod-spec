import type { StyleData } from "../types";
import type { OutputDims } from "../template-registry";
import { resolveOutputLangs, resolveOutputLangCodes, type OutputLang } from "../output-langs";
import { escapeHtml, htmlDocument, tFor } from "./base";
import { loadWashcareSymbols, getWashcareSymbol, type WashcareSymbolMap } from "../washcare-symbols";
import { loadCertificates, type CertificateMap } from "../certificates";
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

// care-label-02 — long care label (35 × 90 mm folded), 4 sheets:
//
//   Sheet 2 FRONT (page 1) — composition per language + wash-care symbols
//   Sheet 2 BACK  (page 2) — care instructions, first language batch
//                            (en, da, de, fi, no, sv, nl)
//   Sheet 3 FRONT (page 3) — care instructions, second batch (fr, pl) +
//                            "Made in [country]" multilingual + PO No +
//                            Contrast brand block
//   Sheet 3 BACK  (page 4) — certificate logos + linked QR image, or
//                            blank when the style declares neither
//
// Why 4 pages: the press runs the strip through twice (one pass per
// sheet, both sides). Each PDF page maps 1:1 to a physical print pass.
// The label folds into 35 × 90 mm.
//
// All content is dynamic via StyleData (composition, care instructions,
// PO number, country of origin). "Made in [X]" phrases resolve at render
// time from the Translation dictionary (Monday board synced into the
// Translation table) — see src/lib/translations/lookup.ts.
//
// Care instructions are composed from DB-managed "care labels" — one line
// each, ordered, edited at /settings/care-labels. Each line can be made
// conditional on the style's wash-care symbols (show-if / hide-if), and
// its per-language text resolves from the Translation dictionary keyed by
// the English source line. See src/lib/care-labels.

// Language coverage on the front/back panels. We render each lang that
// has data; missing langs are skipped. The split between Sheet 2 BACK
// and Sheet 3 FRONT mirrors the printer's reference design.
const LANGS_CARE_TOP: Array<{ code: string; label: string }> = [
  { code: "en", label: "EN" },
  { code: "da", label: "DA" },
  { code: "de", label: "DE" },
  { code: "fi", label: "FI" },
  { code: "no", label: "NO" },
  { code: "sv", label: "SV" },
  { code: "nl", label: "NL" },
];

const LANGS_CARE_BOTTOM: Array<{ code: string; label: string }> = [
  { code: "fr", label: "FR" },
  { code: "pl", label: "PL" },
];

const LANGS_FRONT_COMPOSITION: Array<{ code: string; label: string }> = [
  ...LANGS_CARE_TOP,
  ...LANGS_CARE_BOTTOM,
];

// Languages rendered in the "Made in [country]" block, in print order.
// This is label *layout* config (which lines appear) — the localized
// phrase for each comes from the Translation dictionary at render time
// (translatePhrase(dict, "Made in <country>", code)).
const LANGS_MADE_IN = ["en", "da", "de", "fi", "no", "sv", "nl", "fr", "pl"] as const;

// Split the care-instruction languages across Sheet 2 BACK (top) and Sheet 3
// FRONT (bottom). When the ProdSpec selects an explicit language set, render
// the whole selection on the top panel (Sheet 3 keeps made-in / PO / brand);
// otherwise keep the printer's reference split (en…nl on top, fr/pl below).
function resolveCareLangs(style: StyleData): { top: OutputLang[]; bottom: OutputLang[] } {
  const selected = style.outputLanguages ?? [];
  if (selected.length === 0) return { top: LANGS_CARE_TOP, bottom: LANGS_CARE_BOTTOM };
  return { top: selected.map((code) => ({ code, label: code.toUpperCase() })), bottom: [] };
}

// Print-house brand block. Static today because the SaaS is single-
// tenant for Contrast Company; promote to per-customer config the day
// another print shop signs on.
const BRAND_BLOCK = {
  // Inline SVG keeps the wordmark crisp on the printed label without
  // a network fetch. Kept simple — bold "CONTRAST" + small "COMPANY"
  // subtitle to match the reference design.
  wordmarkSvg: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" preserveAspectRatio="xMidYMid meet">
      <text x="100" y="32" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="26" letter-spacing="2" fill="#000">CONTRAST</text>
      <text x="100" y="46" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="6" letter-spacing="6" fill="#000">COMPANY</text>
    </svg>`,
  address: "Rudolfgårdsvej 6A - 8260 Viby J - DK",
  contact: "www.contrast.dk/info@contrast.dk",
};

export async function renderCareLabel02Html(style: StyleData, dims: OutputDims): Promise<string> {
  const pageSize = { kind: "mm" as const, widthMm: dims.widthMm, heightMm: dims.heightMm };
  const [symbolMap, certMap, dict, allCareLabels] = await Promise.all([
    loadWashcareSymbols(),
    loadCertificates(),
    loadTranslationDictionary(),
    loadCareLabels(),
  ]);

  // Which care labels print for this style. Computed once — identical
  // across every page/language. A line is removed when the style carries a
  // restrictive symbol of the same action ("Do not iron" drops IRONING lines),
  // and the manual show-if / hide-if rules apply on top. Resolve each token
  // through the catalogue so its action + prohibition flag (and canonical code)
  // are known; unknown tokens carry no action and suppress nothing.
  const present: PresentSymbol[] = style.washSymbols.map((token) => {
    const resolved = getWashcareSymbol(symbolMap, token);
    return resolved
      ? { code: resolved.code, action: resolved.action, restrictive: resolved.restrictive }
      : { code: token, action: null, restrictive: false };
  });
  const careLabels = allCareLabels.filter((l) => isCareLabelVisible(l, present));

  // One full 4-page block per size. Content (composition, care text,
  // made-in, PO, brand) is identical across sizes per spec — the press
  // still needs a physical label per size, so the PDF carries the
  // repetition. Fallback to a single block when no sizes are configured
  // (sample / dev rendering).
  const blockCount = Math.max(style.sizes.length, 1);
  const oneBlock = `
    ${pageCompositionAndSymbols(style, symbolMap, dict)}
    ${pageCareTop(style, careLabels, dict)}
    ${pageCareBottomAndBrand(style, careLabels, dict)}
    ${pageCertificatesAndQr(style, certMap)}
  `;
  const body = Array.from({ length: blockCount }, () => oneBlock).join("\n");

  return htmlDocument({
    title: `Care Label 02 — ${style.styleName}`,
    pageSize,
    body,
    barcodeFont: style.barcodeFont,
    extraCss: `
      .page {
        padding: 4mm 3mm;
        font-size: 6pt;
        line-height: 1.2;
        display: flex;
        flex-direction: column;
        height: 100%;
        page-break-after: always;
      }
      .page:last-child { page-break-after: auto; }
      .composition-original { font-weight: 700; margin-bottom: 0.8mm; line-height: 1.2; }
      .lang-rows { display: flex; flex-direction: column; gap: 0.4mm; }
      .lang-row { display: flex; gap: 1mm; align-items: baseline; }
      .lang-row .lang { width: 5mm; flex-shrink: 0; font-weight: 600; color: #000; }
      .lang-row .text { flex: 1; }
      /* Keep every wash-care symbol on a single row. nowrap + a size that
         fits the usable width (≈29 mm after padding): 5 × 4.5 mm + 4 × 1 mm
         gaps = 26.5 mm. */
      .symbols {
        margin-top: auto;
        padding-top: 2mm;
        display: flex;
        flex-wrap: nowrap;
        gap: 1mm;
        justify-content: center;
        align-items: center;
      }
      .symbols img { width: 4.5mm; height: 4.5mm; object-fit: contain; flex-shrink: 0; }
      /* A symbol with no artwork yet falls back to a name tile; cap its
         width and ellipsize so it can't blow out the single row. */
      .symbols .missing {
        font-size: 3.5pt;
        line-height: 1.1;
        max-width: 8mm;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 0.5mm;
        border: 0.15mm dashed #aaa;
        border-radius: 0.5mm;
        color: #999;
      }
      /* Sheet 3 FRONT (page 3) tucks the made-in / PO / brand block at
         the bottom; spacer above pushes them down without losing
         the care-instruction continuation at top. */
      /* Care instructions: one flagged line per language (DA : …, EN : …),
         reusing the .lang-row layout from the composition block. A touch
         more vertical gap + justified body text so the longer care lines
         set tidily. */
      .care-rows { gap: 0.8mm; }
      .care-rows .text { text-align: justify; hyphens: auto; }
      .made-in-block { margin-top: 2.5mm; }
      .made-in-run { font-size: 5.5pt; line-height: 1.2; text-align: justify; }
      .po-line {
        margin-top: 2mm;
        font-size: 6pt;
        font-weight: 600;
      }
      .brand-block {
        margin-top: 2mm;
        text-align: center;
      }
      .brand-block .wordmark { width: 22mm; margin: 0 auto 1mm; }
      .brand-block .wordmark svg { width: 100%; height: auto; display: block; }
      .brand-block .addr { font-size: 4.5pt; line-height: 1.2; }
      .empty-page {
        display: flex; align-items: center; justify-content: center;
        height: 100%; color: #ccc; font-size: 4pt; font-style: italic;
      }
      /* Page 4 — certificate logos + QR, centred vertically. */
      .page-certs { align-items: center; justify-content: center; gap: 3mm; }
      .cert-row {
        display: flex;
        flex-wrap: wrap;
        gap: 2mm;
        justify-content: center;
        align-items: center;
      }
      .cert-logo { max-width: 14mm; max-height: 10mm; object-fit: contain; }
      .cert-missing {
        font-size: 5pt;
        padding: 0.5mm 1mm;
        border: 0.15mm dashed #aaa;
        border-radius: 0.5mm;
        color: #999;
      }
      .qr { display: flex; justify-content: center; }
      .qr img { width: 18mm; height: 18mm; object-fit: contain; }
    `,
  });
}

// -----------------------------------------------------
// Page 1 — Sheet 2 FRONT: composition + wash care symbols
// -----------------------------------------------------
function pageCompositionAndSymbols(
  style: StyleData,
  symbolMap: WashcareSymbolMap,
  dict: TranslationDictionary,
): string {
  // "Original" composition line: the raw-entered value, which is always
  // English — un-prefixed entries are stored as EN by the mapper, and
  // multilingual entries carry an explicit EN. Shown first as the
  // authoritative line; the per-language rows below are localized
  // translations of it.
  const originalText = tFor(style.composition, "en") || style.composition[0]?.text || "";
  const originalRow = originalText
    ? `<div class="composition-original">${escapeHtml(originalText)}</div>`
    : "";

  // Translations: every language EXCEPT EN (rendered above as the
  // original). An operator-entered translation wins; otherwise we pull it
  // from the Translation board (the same dictionary the care instructions
  // and "Made in <country>" lines use) so the operator only has to type the
  // English composition once. translatePhrase degrades to the English
  // source when the board has no entry for that language — we skip those so
  // the label never prints "PL : <English>".
  const translationRows = resolveOutputLangs(style, LANGS_FRONT_COMPOSITION)
    .filter(({ code }) => code !== "en")
    .map(({ code, label }) => {
      const entered = tFor(style.composition, code);
      const translated = originalText
        ? translateComposition(dict, originalText, code)
        : { text: "", changed: false };
      const text = entered || translated.text;
      // Render the row when the operator typed a translation, or the board
      // translated at least one fibre. Otherwise skip — never print the
      // English composition under a non-English flag.
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
      const resolved = getWashcareSymbol(symbolMap, token);
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      const label = resolved?.name ?? token;
      return `<span class="missing">${escapeHtml(label)}</span>`;
    })
    .join("");

  return `
    <div class="page">
      ${compositionBlock}
      ${symbols ? `<div class="symbols">${symbols}</div>` : ""}
    </div>`;
}

// -----------------------------------------------------
// Page 2 — Sheet 2 BACK: care instructions, first batch
// -----------------------------------------------------
function pageCareTop(
  style: StyleData,
  labels: CareLabel[],
  dict: TranslationDictionary,
): string {
  const rows = careLangRows(style, resolveCareLangs(style).top, labels, dict);
  if (!rows) {
    return `
      <div class="page">
        <div class="empty-page">
          Sheet 2 BACK: no care instructions to print. No care labels are
          visible for this style's wash symbols, or none are configured
          (see /settings/care-labels).
        </div>
      </div>`;
  }
  return `<div class="page"><div class="lang-rows care-rows">${rows}</div></div>`;
}

// -----------------------------------------------------
// Page 3 — Sheet 3 FRONT: care continuation + made-in + PO + brand
// -----------------------------------------------------
function pageCareBottomAndBrand(
  style: StyleData,
  labels: CareLabel[],
  dict: TranslationDictionary,
): string {
  const careRows = careLangRows(style, resolveCareLangs(style).bottom, labels, dict);
  const madeIn = renderMadeInBlock(
    style.countryOfOrigin,
    dict,
    resolveOutputLangCodes(style, LANGS_MADE_IN),
  );
  const po = style.poNumber
    ? `<div class="po-line">PO No.: ${escapeHtml(style.poNumber)}</div>`
    : "";
  const brand = `
    <div class="brand-block">
      <div class="wordmark">${BRAND_BLOCK.wordmarkSvg}</div>
      <div class="addr">${escapeHtml(BRAND_BLOCK.address)}</div>
      <div class="addr">${escapeHtml(BRAND_BLOCK.contact)}</div>
    </div>`;
  return `
    <div class="page">
      ${careRows ? `<div class="lang-rows care-rows">${careRows}</div>` : ""}
      ${madeIn}
      ${po}
      ${brand}
    </div>`;
}

// -----------------------------------------------------
// Page 4 — Sheet 3 BACK: certificate logos + QR image, or blank
// -----------------------------------------------------
// Renders the logos for whichever certificates the Style declares
// (matched case-insensitively against the Certificate library) plus the
// style's linked QR image. When neither resolves, the sheet stays blank
// — the back of the strip is intentionally empty in that case.
function pageCertificatesAndQr(style: StyleData, certMap: CertificateMap): string {
  const names = style.certificates ?? [];
  const certs = names
    .map((name) => {
      const resolved = certMap.get(name.trim().toLowerCase());
      if (resolved?.dataUrl) {
        return `<img class="cert-logo" src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      // Declared on the style but no logo in the library yet — show the
      // bare name as a "needs artwork" tile (mirrors the wash-symbol
      // missing tile) so review surfaces the gap before printing.
      return `<span class="cert-missing">${escapeHtml(name)}</span>`;
    })
    .join("");

  const qr = style.qrImageUrl
    ? `<div class="qr"><img src="${style.qrImageUrl}" alt="QR code" /></div>`
    : "";

  if (!certs && !qr) {
    return `<div class="page"><div class="empty-page">Sheet 3 BACK · intentionally blank</div></div>`;
  }

  return `
    <div class="page page-certs">
      ${certs ? `<div class="cert-row">${certs}</div>` : ""}
      ${qr}
    </div>`;
}

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------
// Care instructions, one flagged line PER LANGUAGE — "DA : …", "EN : …",
// "PL : …" — matching the customer reference (and the composition rows
// above). Each language's line is its visible care labels joined by " / ".
// Per-label text comes from the Translation dictionary keyed by the English
// source line; an untranslated label falls back to its English text
// (translatePhrase) so a care line is never silently dropped. A per-style
// careInstructionsByLang override still wins verbatim per language. Returns
// the joined HTML rows, or "" when there's nothing to print.
function careLangRows(
  style: StyleData,
  langs: Array<{ code: string; label: string }>,
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

  // The full "Made in <country>" phrase is resolved per language straight
  // from the Translation dictionary, which mirrors the Monday translations
  // board ("Made in China" → "Fremstillet i Kina", …). Edit the wording in
  // Monday, not here. When a country has no board entry every language
  // degrades to the same English phrase — collapse those to a single line
  // rather than print the identical sentence nine times.
  // One continuous " / "-separated run, no language flags — same shape as
  // the care instructions. Dedupe while preserving print order so that
  // languages whose phrase coincides don't repeat; when nothing is
  // translated every language collapses to the single English phrase.
  const seen = new Set<string>();
  const phrases = langCodes
    .map((code) => translatePhrase(dict, english, code).trim())
    .filter((p) => p && !seen.has(p) && (seen.add(p), true));
  const text = phrases.length > 0 ? phrases.join(" / ") : english;

  return `<div class="made-in-block"><div class="made-in-run">${escapeHtml(text)}</div></div>`;
}
