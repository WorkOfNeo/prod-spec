// Canonical input shape for every PDF template. Once Dilip delivers the
// column mapping doc, src/lib/pdf/mapper.ts fills this from a Monday item.

import type { BarcodeFontConfig } from "./barcode";

export type SizeVariant = {
  label: string;
  ean13: string;
};

// Free-text identifier for a wash-care symbol. Used to be a strict union
// of the 16 ISO 3758 codes; now any string, defined by admins via the
// WashSymbol table at /settings/washcare-symbols.
export type WashSymbolCode = string;

export type StyleData = {
  styleName: string;
  styleNumber: string;
  customerName: string;
  customerLogoUrl?: string;
  businessArea: "PL" | "LICENSE" | "BRAND_HOUSE" | "LOVED" | "D2C" | "SPARK_SHOP" | "STOCK" | string;

  // ISO 639-1 lowercase code, free-text — templates pick which langs they
  // render. Was restricted to en/de/da/no/sv/fi; widened to accept nl/fr/pl
  // and any other code the operator types.
  composition: Array<{ language: string; text: string }>;
  productNameTranslations: Array<{ language: string; text: string }>;
  washSymbols: WashSymbolCode[];

  sizes: SizeVariant[];

  carton: {
    klNumber: string;
    supplierNumber: string;
    lot: string;
    outerVE: number;
    ean13: string;
  };

  colour?: {
    name: string;
    code: string;
  };

  price?: {
    amount: number;
    currency: "EUR" | "DKK" | "NOK" | "SEK" | "GBP";
  };

  supplierEmail?: string;

  // PO number lifted from the Styles board's #PO Number column. Surfaced
  // on long care labels (care-label-02) as "PO No. C-PO62662". Doubles as
  // the *Contrast* order number on DDP carton markings.
  poNumber?: string;

  // Customer's own order number (Pre-Order "🔢 Customer Order Number"
  // column). Printed on FOB carton markings; the Contrast poNumber is used
  // for DDP. Empty unless the column is mapped / populated.
  customerOrderNo?: string;

  // Delivery term for the order — free text, expected "FOB" or "DDP"
  // (sourced from a Pre-Order board column). The Netto carton marking
  // switches which order number it prints on it: FOB → customerOrderNo,
  // anything else (incl. empty) → poNumber (Contrast). See the
  // netto-dk-privatelabel/carton-marking template.
  deliveryTerm?: string;

  // Country of origin (free text — e.g. "India", "China"). Sourced from
  // the Styles-board "🌍 Country of Origin" mirror column, which proxies
  // the linked Supplier's country. Used by care-label-02 to render
  // "Made in [country]" in multiple languages on the back panel.
  countryOfOrigin?: string;

  // Per-customer presentation context — barcode font + (optional) logo URL.
  // Per-output mm dimensions are passed to each template variant explicitly
  // by the runner; they don't live on StyleData any more.
  barcodeFont?: BarcodeFontConfig;
  // SVG markup attached to the ProdSpec (Customer × BusinessArea) — used
  // by templates that render a branded header (care-label-01, etc.).
  // Falls back to customerLogoUrl when the template supports both.
  prodSpecLogoSvg?: string | null;
  // Per-language care-instruction strings stored on the ProdSpec.
  // Lowercase ISO 639-1 keys. Empty / missing langs are skipped by the
  // template (no placeholder).
  careInstructionsByLang?: Record<string, string>;

  // Languages this style's outputs should render, as lowercase codes
  // (the ProdSpec's selected `outputLanguages`). Templates iterate these
  // instead of their hardcoded language list. Empty / undefined ⇒ the
  // template falls back to its built-in default set. See
  // src/lib/pdf/output-langs.ts (resolveOutputLangs).
  outputLanguages?: string[];

  // Certificate names attached to the style, parsed from the Monday
  // "__certificates__1" column (e.g. ["FSC", "OEKOTEX"]). care-label-02
  // page 4 resolves each against the Certificate library and prints the
  // logos that match. Empty when none configured.
  certificates?: string[];

  // Per-style QR image as a data URL ("data:image/png;base64,…"),
  // resolved by the runner from the linked QrImage library row. Rendered
  // as-is on care-label-02 page 4. Null / undefined when no QR is linked.
  qrImageUrl?: string | null;
};
