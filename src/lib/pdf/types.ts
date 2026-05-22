// Canonical input shape for every PDF template. Once Dilip delivers the
// column mapping doc, src/lib/pdf/mapper.ts fills this from a Monday item.

export type SizeVariant = {
  label: string;
  ean13: string;
};

export type WashSymbolCode =
  | "wash30"
  | "wash40"
  | "wash60"
  | "wash_hand"
  | "wash_no"
  | "bleach_no"
  | "bleach_oxygen"
  | "tumble_low"
  | "tumble_normal"
  | "tumble_no"
  | "iron_low"
  | "iron_medium"
  | "iron_high"
  | "iron_no"
  | "dryclean"
  | "dryclean_no";

export type StyleData = {
  styleName: string;
  styleNumber: string;
  customerName: string;
  customerLogoUrl?: string;
  businessArea: "PL" | "LICENSE" | "BRAND_HOUSE" | "LOVED" | "D2C" | "SPARK_SHOP" | "STOCK" | string;

  composition: Array<{ language: "en" | "de" | "da" | "no" | "sv" | "fi"; text: string }>;
  productNameTranslations: Array<{ language: "en" | "de" | "da" | "no" | "sv" | "fi"; text: string }>;
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
};
