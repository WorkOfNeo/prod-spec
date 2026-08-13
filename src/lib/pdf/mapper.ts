import type { MondayItem } from "@/lib/monday/client";
import { columnText } from "@/lib/monday/client";
import type { StyleData, SizeVariant, WashSymbolCode } from "./types";
import { computeEan13Checksum, isValidEan13, DEFAULT_BARCODE_FONT, type BarcodeFontConfig } from "./barcode";
import { MANUAL_COLUMN_IDS, type ColumnMapping, type CustomerConfig } from "@/lib/customers/config";

export type MapperOptions = {
  customerName: string;
  customerLogoUrl?: string;
  barcodeFont?: BarcodeFontConfig;
  prodSpecLogoSvg?: string | null;
  careInstructionsByLang?: Record<string, string>;
  // ProdSpec.outputLanguages — the languages this style's outputs render.
  outputLanguages?: string[];
  // Resolved by the runner from the Style's linked QrImage row. Threaded
  // through here (rather than read from a Monday column) because it's a
  // per-style DB link, not synced board data.
  qrImageUrl?: string | null;
};

// Customer-config-driven mapper. The `columnMapping` argument comes from
// Customer.config.columnMapping — any field not mapped is left empty and
// will surface as a missing required field if it's required.
//
// `options` lets the runner inject per-customer presentation knobs
// (barcode font, logo URL) and per-ProdSpec output dimensions without
// touching the column-mapping layer.
export function mapMondayItemToStyleData(
  item: MondayItem,
  customerNameOrOptions: string | MapperOptions,
  mapping: ColumnMapping,
  customerConfig?: CustomerConfig,
): StyleData {
  const opts: MapperOptions =
    typeof customerNameOrOptions === "string"
      ? {
          customerName: customerNameOrOptions,
          customerLogoUrl: customerConfig?.logoUrl,
          barcodeFont: customerConfig?.barcodeFont ?? DEFAULT_BARCODE_FONT,
        }
      : customerNameOrOptions;
  // Read a semantic field by its mapped Monday column id first (keeps
  // Monday authoritative for webhook-ingested styles), then fall back to
  // the `manual.*` namespace where the manual-entry / edit form stores
  // hand-typed values. Without the fallback, manually entered styles map
  // to empty strings whenever the customer mapping points at a Monday/
  // Pre-Order column that was never enriched.
  const readField = (field: keyof ColumnMapping): string => {
    const mapped = mapping[field];
    if (mapped) {
      const v = columnText(item, mapped);
      if (v) return v;
    }
    return columnText(item, MANUAL_COLUMN_IDS[field]);
  };

  const businessArea = readField("businessArea") || "PL";

  return {
    styleName: item.name,
    styleNumber: readField("styleNumber") || item.id,
    customerName: opts.customerName,
    customerLogoUrl: opts.customerLogoUrl,
    businessArea,
    composition: parseTranslations(readField("composition")),
    productNameTranslations: parseTranslations(readField("productNameTranslations")),
    washSymbols: parseWashSymbols(readField("washCare")),
    sizes: parseSizes(readField("sizes"), readField("ean13")),
    cartonQtyRaw: readField("cartonQty") || undefined,
    sizeRatioRaw: readField("sizeRatio") || undefined,
    carton: {
      klNumber: readField("klNumber"),
      supplierNumber: readField("supplierNumber"),
      lot: readField("lot"),
      outerVE: Number(readField("cartonQty")) || 0,
      ean13: ensureValidEan(readField("cartonEan")),
      // Master/assortment carton (injected as manual.assortEan = Style.cartonEan).
      // Same value as ean13 on the base style; kept distinct so it survives the
      // per-EAN repeat, where ean13 is rebound to each size's own carton.
      assortEan: ensureValidEan(readField("assortEan")),
    },
    colour: {
      name: readField("colourName"),
      code: readField("colourCode"),
    },
    productGroup: readField("productGroup") || undefined,
    price: parsePrice(readField("price")),
    supplierEmail: readField("supplierEmail") || undefined,
    poNumber: readField("poNumber") || undefined,
    customerOrderNo: readField("customerOrderNo") || undefined,
    deliveryTerm: readField("deliveryTerm") || undefined,
    countryOfOrigin: readField("countryOfOrigin") || undefined,
    customerItemNo: readField("customerItemNo") || undefined,
    campaignWeek: readField("campaignWeek") || undefined,
    batchNo: readField("batchNo") || undefined,
    prodNumber: readField("prodNumber") || undefined,
    description: readField("description") || undefined,
    barcodeFont: opts.barcodeFont ?? DEFAULT_BARCODE_FONT,
    prodSpecLogoSvg: opts.prodSpecLogoSvg ?? null,
    careInstructionsByLang: opts.careInstructionsByLang ?? {},
    outputLanguages: opts.outputLanguages ?? [],
    certificates: parseCertificates(readField("certificates")),
    qrImageUrl: opts.qrImageUrl ?? null,
  };
}

// Certificates arrive as a comma-separated list ("FSC, OEKOTEX") in the
// mapped column. Split, trim, drop blanks. Names are matched against the
// Certificate library case-insensitively at render time.
function parseCertificates(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTranslations(raw: string): StyleData["composition"] {
  if (!raw) return [];
  const parsed = raw
    .split("|")
    .map((part) => part.trim())
    .map((part) => {
      const match = part.match(/^([A-Z]{2}):\s*(.+)$/i);
      if (!match) return null;
      return { language: match[1].toLowerCase(), text: match[2] };
    })
    .filter((x): x is StyleData["composition"][number] => x !== null);

  // Forgiveness: operators frequently enter a single un-prefixed line
  // ("95% Cotton, 5% Elastan") instead of the "XX: …" multilingual form.
  // Rather than dropping it (which surfaced as "No composition
  // translations entered."), treat the whole value as the English entry
  // so it still prints. Multilingual output requires the "XX:" prefix.
  if (parsed.length === 0) {
    return [{ language: "en", text: raw.trim() }];
  }
  return parsed;
}

function parseWashSymbols(raw: string): WashSymbolCode[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as WashSymbolCode[];
}

// Sizes are split across two columns:
//   - sizes column: comma-separated labels, e.g. "XS,S,M,L,XL"
//   - ean13 column: per-size EAN map, e.g. "XS=4710000000001,S=4710000000018"
// We join them by label. Labels are case-insensitive. If sizes column is
// empty we fall back to ONE-SIZE using the ean13 column verbatim (treated
// as a single EAN string). If a size has no EAN match, it gets a zero-EAN
// placeholder so the barcode still renders (just clearly invalid).
//
// Future: when PDF-parsing of PO files lands, parseSizes signature stays;
// only the upstream source of the ean13 string changes.
function parseSizes(sizeLabels: string, eanMap: string): SizeVariant[] {
  const labels = sizeLabels
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const eans = parseEanMap(eanMap);

  if (labels.length === 0) {
    // No labels configured. If the ean13 column looks like a single EAN
    // (no '=' inside), treat it as a one-size barcode; otherwise no sizes.
    if (eanMap && !eanMap.includes("=")) {
      return [{ label: "ONE-SIZE", ean13: ensureValidEan(eanMap.trim()) }];
    }
    return [];
  }

  return labels.map((label) => ({
    label,
    ean13: ensureValidEan(eans[label.toLowerCase()] ?? ""),
  }));
}

function parseEanMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || !v) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

// A currency word that may sit before OR after the amount — Monday's
// "Retail Prices" column is free text and buyers write the currency on
// whichever side they please ("KR 69,95", "Kr. 39,00", "129.95 DKK").
//
// It is matched only to be REMOVED. We deliberately never lift it into
// price.currency:
//   • layouts already print their own currency text — the Coop DR barcode
//     tag's line is literally "{{price}} KR", so echoing it back would
//     render "69.95 DKK KR";
//   • "KR" isn't an ISO code and is ambiguous across DKK/NOK/SEK, so
//     mapping it would mean guessing from the customer;
//   • every value that parses today is a bare number, so no live style
//     loses a currency it used to print.
const CURRENCY_WORD = /(?:kr\.?|dkk|nok|sek|eur|gbp|chf|usd|[€£$])/i;
const LEADING_CURRENCY = new RegExp(`^${CURRENCY_WORD.source}\\s*`, "i");
const TRAILING_CURRENCY = new RegExp(`\\s*${CURRENCY_WORD.source}$`, "i");

// What's left after the currency word is stripped must be ONE number, with
// optional thousands groups and at most two decimals. Anything else — a
// second amount, stray words — is rejected rather than guessed at.
const AMOUNT = /^\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?$/;

// Both "." and "," appear as the decimal separator in live data (and both
// appear as thousands separators elsewhere), so the separator's MEANING is
// decided by what follows it: three trailing digits is a thousands group,
// one or two is the decimal part.
function toAmount(s: string): number | undefined {
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (lastSep === -1) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const after = s.slice(lastSep + 1);
  const [intPart, fracPart] =
    after.length === 3
      ? [s.replace(/[.,]/g, ""), ""] // "1.299" → 1299
      : [s.slice(0, lastSep).replace(/[.,]/g, ""), after]; // "1.299,95" → 1299.95
  const n = Number(fracPart ? `${intPart}.${fracPart}` : intPart);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePrice(raw: string): StyleData["price"] | undefined {
  if (!raw) return undefined;
  let s = raw.trim();

  // "PER SÆT:KR 129,95" — Coop buyers prefix the value with the very label
  // the layout already prints for itself ({{if productGroup contains Set}}
  // PER SÆT{{else}}KR.{{endif}}), so drop everything up to the last colon
  // and price what follows.
  const colon = s.lastIndexOf(":");
  if (colon !== -1) s = s.slice(colon + 1).trim();

  s = s.replace(LEADING_CURRENCY, "").replace(TRAILING_CURRENCY, "").trim();

  // Rejected here, on purpose:
  //   "See customer order" — 100 live styles; not a price, must stay empty.
  //   "99 SEK, 69 DKK"     — two amounts for two markets. Stripping the
  //                          trailing DKK leaves "99 SEK, 69", which fails
  //                          AMOUNT, so nothing prints. Picking one would
  //                          put the wrong market's number on a physical
  //                          label, which is worse than printing none.
  if (!AMOUNT.test(s)) return undefined;
  const amount = toAmount(s);
  if (amount === undefined) return undefined;
  return { amount };
}

function ensureValidEan(input: string): string {
  if (!input) return "0000000000000";
  if (isValidEan13(input)) return input;
  if (/^\d{12}$/.test(input)) return computeEan13Checksum(input);
  return "0000000000000";
}
