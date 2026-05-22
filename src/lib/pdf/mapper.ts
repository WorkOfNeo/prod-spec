import type { MondayItem } from "@/lib/monday/client";
import { columnText } from "@/lib/monday/client";
import type { StyleData, SizeVariant, WashSymbolCode } from "./types";
import { computeEan13Checksum, isValidEan13 } from "./barcode";
import type { ColumnMapping } from "@/lib/customers/config";

// Customer-config-driven mapper. The `columnMapping` argument comes from
// Customer.config.columnMapping — any field not mapped is left empty and
// will surface as a missing required field if it's required.
export function mapMondayItemToStyleData(
  item: MondayItem,
  customerName: string,
  mapping: ColumnMapping,
): StyleData {
  const read = (key?: string) => (key ? columnText(item, key) : "");

  const businessArea = read(mapping.businessArea) || "PL";

  return {
    styleName: item.name,
    styleNumber: read(mapping.styleNumber) || item.id,
    customerName,
    businessArea,
    composition: parseTranslations(read(mapping.composition)),
    productNameTranslations: parseTranslations(read(mapping.productNameTranslations)),
    washSymbols: parseWashSymbols(read(mapping.washCare)),
    sizes: parseSizes(read(mapping.sizes), read(mapping.ean13)),
    carton: {
      klNumber: read(mapping.klNumber),
      supplierNumber: read(mapping.supplierNumber),
      lot: read(mapping.lot),
      outerVE: Number(read(mapping.cartonQty)) || 0,
      ean13: ensureValidEan(read(mapping.cartonEan)),
    },
    colour: {
      name: read(mapping.colourName),
      code: read(mapping.colourCode),
    },
    price: parsePrice(read(mapping.price)),
    supplierEmail: read(mapping.supplierEmail) || undefined,
  };
}

function parseTranslations(raw: string): StyleData["composition"] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((part) => part.trim())
    .map((part) => {
      const match = part.match(/^([A-Z]{2}):\s*(.+)$/i);
      if (!match) return null;
      return { language: match[1].toLowerCase() as StyleData["composition"][number]["language"], text: match[2] };
    })
    .filter((x): x is StyleData["composition"][number] => x !== null);
}

function parseWashSymbols(raw: string): WashSymbolCode[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as WashSymbolCode[];
}

function parseSizes(raw: string, fallbackEan: string): SizeVariant[] {
  // Phase 1 placeholder. Real path depends on barcode-source decision:
  //   Option A: read Monday subitems (one per size, each with an EAN column)
  //   Option B: parse EAN list from the PO PDF stored in SharePoint
  // Once decided, this function (and only this function) needs to change.
  if (!raw) return [{ label: "ONE-SIZE", ean13: ensureValidEan(fallbackEan) }];
  return raw.split(",").map((label) => ({
    label: label.trim(),
    ean13: ensureValidEan(""),
  }));
}

function parsePrice(raw: string): StyleData["price"] | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^([\d.,]+)\s*([A-Z]{3})?$/);
  if (!match) return undefined;
  const amount = parseFloat(match[1].replace(",", "."));
  if (Number.isNaN(amount)) return undefined;
  const currency = (match[2] ?? "EUR") as NonNullable<StyleData["price"]>["currency"];
  return { amount, currency };
}

function ensureValidEan(input: string): string {
  if (!input) return "0000000000000";
  if (isValidEan13(input)) return input;
  if (/^\d{12}$/.test(input)) return computeEan13Checksum(input);
  return "0000000000000";
}
