import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { escapeHtml, fontBarcode, htmlDocument, tFor } from "../base";
import { loadWashcareSymbols, getWashcareSymbol, type WashcareSymbolMap } from "../../washcare-symbols";
import { resolveOutputLangCodes } from "../../output-langs";
import {
  loadTranslationDictionary,
  translateComposition,
  type TranslationDictionary,
} from "@/lib/translations/lookup";

// netto-dk-privatelabel · Info Area — the block direct-printed onto the
// product packaging. Per the reference PDF it carries three things:
// composition, the EAN barcode, and the wash-care symbols. Modelled on the
// (removed) generic washcare template so it renders through the same path.
//
// One page per size (each size has its own EAN). Danish leads the
// composition for the Netto DK market, then EN/DE if present; adjust the
// list below if more languages are needed on the pack.
const LANGUAGES_FOR_INFO_AREA: Array<"da" | "en" | "de"> = ["da", "en", "de"];

export async function renderNettoInfoAreaHtml(style: StyleData, dims: OutputDims): Promise<string> {
  const pageSize = { kind: "mm" as const, widthMm: dims.widthMm, heightMm: dims.heightMm };

  // Global symbol catalogue (short-TTL cache lives in washcare-symbols.ts)
  // + the Translation board, so composition can be filled per-language from
  // the dictionary instead of every language being typed by hand.
  const [symbolMap, dict] = await Promise.all([
    loadWashcareSymbols(),
    loadTranslationDictionary(),
  ]);

  // Fall back to one placeholder page so the operator sees the layout even
  // when sizes/EANs haven't landed yet, rather than a blank PDF.
  const sizesToRender =
    style.sizes.length > 0 ? style.sizes : [{ label: "—", ean13: "0000000000000" } as const];

  const pages = sizesToRender
    .map((size) => infoAreaPage(style, size.label, size.ean13, symbolMap, dict))
    .join("\n");

  return htmlDocument({
    title: `Info Area — ${style.styleName}`,
    pageSize,
    body: pages,
    barcodeFont: style.barcodeFont,
    extraCss: `
      .page {
        padding: 3mm;
        font-size: 6.5pt;
        line-height: 1.25;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .caption { font-size: 5.5pt; letter-spacing: 0.04em; color: #666; text-transform: uppercase; }
      .composition { margin-top: 1.5mm; }
      .composition .row { margin-bottom: 0.6mm; }
      .composition .lang { font-weight: 600; }
      .symbols { display: flex; flex-wrap: wrap; gap: 1.5mm; margin-top: 2mm; align-items: center; }
      .symbols img { width: 6mm; height: 6mm; object-fit: contain; }
      .symbols .missing { font-size: 6pt; padding: 0.5mm 1mm; border: 0.2mm dashed #999; color: #999; border-radius: 0.5mm; }
      .barcode-row { margin-top: auto; padding-top: 2mm; text-align: center; }
    `,
  });
}

function infoAreaPage(
  style: StyleData,
  sizeLabel: string,
  ean13: string,
  symbolMap: WashcareSymbolMap,
  dict: TranslationDictionary,
): string {
  // English composition is the source for board translations; an
  // operator-entered per-language value still wins. translatePhrase falls
  // back to English when the board lacks a language — skip those so we don't
  // print an English line under a non-EN flag.
  const originalText = tFor(style.composition, "en") || style.composition[0]?.text || "";
  const composition = resolveOutputLangCodes(style, LANGUAGES_FOR_INFO_AREA).map((lang) => {
    const entered = tFor(style.composition, lang);
    const translated = originalText
      ? translateComposition(dict, originalText, lang)
      : { text: "", changed: false };
    const text = entered || translated.text;
    // Skip a non-EN line that neither was typed nor had any fibre translated
    // (don't print the English composition under a non-EN flag). EN shows.
    if (!text || (lang !== "en" && !entered && !translated.changed)) return "";
    return `<div class="row"><span class="lang">${lang.toUpperCase()}</span> ${escapeHtml(text)}</div>`;
  })
    .filter(Boolean)
    .join("");

  const symbols = style.washSymbols
    .map((token) => {
      const resolved = getWashcareSymbol(symbolMap, token);
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      // Symbol exists but no SVG uploaded yet, OR token unknown — render a
      // tagged placeholder so the gap is visible on the proof, never silently
      // dropped.
      const label = resolved?.name ?? token;
      return `<span class="missing" title="No SVG uploaded for &quot;${escapeHtml(token)}&quot;">${escapeHtml(label)}</span>`;
    })
    .join("");

  return `
    <div class="page">
      <div class="caption">${escapeHtml(style.customerName)} · ${escapeHtml(sizeLabel)}</div>
      <div class="composition">${composition}</div>
      ${symbols ? `<div class="symbols">${symbols}</div>` : ""}
      <div class="barcode-row">${fontBarcode(ean13, style.barcodeFont, "22pt")}</div>
    </div>`;
}
