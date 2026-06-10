// =====================================================
// Token metadata — the CLIENT-SAFE half of the layout variable system.
// The builder palette, canvas highlighting and publish validation all
// read this; it must stay free of server imports (db, bwip-js, template
// code). The matching server-side resolvers live in tokens.ts, keyed by
// the same token keys — keep the two files in sync.
// =====================================================

export type LayoutTokenKind = "text" | "barcode" | "symbols" | "image";

export type LayoutTokenMeta = {
  key: string;
  label: string;
  group: "Style" | "Order & carton" | "Per language" | "Barcodes & symbols";
  kind: LayoutTokenKind;
  // "lang" → the token takes a language argument ({{composition:da}});
  // "source" → barcode source argument ({{barcode:cartonEan}}).
  arg?: "lang" | "source";
  // Example value shown in the palette tooltip.
  example?: string;
};

export const LAYOUT_TOKENS: LayoutTokenMeta[] = [
  // ---- Style ----
  { key: "styleName", label: "Style name", group: "Style", kind: "text", example: "2044 PAW PATROL TEE" },
  { key: "styleNumber", label: "Style number", group: "Style", kind: "text", example: "IL97261" },
  { key: "customerName", label: "Customer name", group: "Style", kind: "text", example: "Netto A/S" },
  { key: "description", label: "Description", group: "Style", kind: "text", example: "T-Shirt Paw Patrol – Blue" },
  { key: "customerItemNo", label: "Customer item no", group: "Style", kind: "text", example: "223609" },
  { key: "countryOfOrigin", label: "Country of origin", group: "Style", kind: "text", example: "India" },
  { key: "colourName", label: "Colour name", group: "Style", kind: "text", example: "Navy" },
  { key: "colourCode", label: "Colour code", group: "Style", kind: "text", example: "19-3920" },
  { key: "campaignWeek", label: "Campaign week", group: "Style", kind: "text", example: "C182813" },
  { key: "sizes", label: "Sizes (all)", group: "Style", kind: "text", example: "86/92, 98/104, 110/116" },
  {
    key: "size",
    label: "Size (current — first, or the repetition's)",
    group: "Style",
    kind: "text",
    example: "98/104",
  },
  { key: "sizeRange", label: "Size range", group: "Style", kind: "text", example: "86/92–110/116" },
  { key: "price", label: "Retail price", group: "Style", kind: "text", example: "29.00 DKK" },

  // ---- Order & carton ----
  { key: "poNumber", label: "PO number (Contrast)", group: "Order & carton", kind: "text", example: "C-PO62831" },
  { key: "customerOrderNo", label: "Customer order no", group: "Order & carton", kind: "text", example: "4501122334" },
  {
    key: "orderNo",
    label: "Order no (FOB→customer, DDP→PO)",
    group: "Order & carton",
    kind: "text",
    example: "C-PO62831",
  },
  { key: "qtyPerCarton", label: "Qty per carton", group: "Order & carton", kind: "text", example: "48" },
  { key: "cartonEan", label: "Carton EAN (number)", group: "Order & carton", kind: "text", example: "5701234567890" },
  { key: "ean13", label: "EAN-13 first size (number)", group: "Order & carton", kind: "text", example: "5701234567104" },
  { key: "batchNo", label: "Batch no", group: "Order & carton", kind: "text", example: "48835447" },
  { key: "prodNumber", label: "Prod number", group: "Order & carton", kind: "text", example: "GI10024" },
  { key: "lot", label: "Lot", group: "Order & carton", kind: "text", example: "LOT-22" },
  { key: "klNumber", label: "KL number", group: "Order & carton", kind: "text", example: "KL 1042" },
  { key: "supplierNumber", label: "Supplier number", group: "Order & carton", kind: "text", example: "60112" },
  {
    key: "deliveryTerm",
    label: "Delivery term (FOB/DDP)",
    group: "Order & carton",
    kind: "text",
    example: "DDP",
  },

  // ---- Per language (need :lang) ----
  { key: "composition", label: "Composition", group: "Per language", kind: "text", arg: "lang", example: "{{composition:da}}" },
  { key: "productName", label: "Product name", group: "Per language", kind: "text", arg: "lang", example: "{{productName:de}}" },
  {
    key: "careInstructions",
    label: "Care instructions (standard, filtered by wash icons; Prod Spec text overrides)",
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "{{careInstructions:en}}",
  },
  {
    key: "madeIn",
    label: "Made in <country> (translated)",
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "Fremstillet i Kina",
  },

  // ---- Barcodes & symbols (rendered as graphics, scaled by block font size) ----
  { key: "barcode", label: "Barcode", group: "Barcodes & symbols", kind: "barcode", arg: "source", example: "{{barcode:cartonEan}}" },
  {
    key: "washSymbols",
    label: "Wash care symbols",
    group: "Barcodes & symbols",
    kind: "symbols",
    example: "{{washSymbols}}",
  },
  {
    key: "logo",
    label: "Logo (contrast = repo file, custom = uploaded)",
    group: "Barcodes & symbols",
    kind: "image",
    arg: "source",
    example: "{{logo:contrast}}",
  },
];

export const BARCODE_SOURCES = ["cartonEan", "ean13"] as const;
export type BarcodeSource = (typeof BARCODE_SOURCES)[number];

export const LOGO_SOURCES = ["contrast", "custom"] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

// Allowed :arg values for source-typed tokens, per key.
const SOURCES_BY_KEY: Record<string, readonly string[]> = {
  barcode: BARCODE_SOURCES,
  logo: LOGO_SOURCES,
};

const META_BY_KEY = new Map(LAYOUT_TOKENS.map((t) => [t.key, t]));

export function tokenMeta(key: string): LayoutTokenMeta | null {
  return META_BY_KEY.get(key) ?? null;
}

// Validation shared by the builder (live) and the publish endpoint
// (gate): unknown keys, missing/invalid args. Returns [] when clean.
export function validateTokenRef(key: string, arg?: string): string[] {
  const meta = tokenMeta(key);
  if (!meta) return [`unknown variable {{${key}${arg ? `:${arg}` : ""}}}`];
  const errs: string[] = [];
  if (meta.arg === "lang" && !arg) {
    errs.push(`{{${key}}} needs a language, e.g. {{${key}:en}}`);
  }
  if (meta.arg === "source") {
    const allowed = SOURCES_BY_KEY[key] ?? [];
    if (!arg || !allowed.includes(arg)) {
      errs.push(
        `{{${key}${arg ? `:${arg}` : ""}}} needs a source: ${allowed.map((s) => `{{${key}:${s}}}`).join(" or ")}`,
      );
    }
  }
  if (!meta.arg && arg) {
    errs.push(`{{${key}}} does not take an argument (got ":${arg}")`);
  }
  return errs;
}

// ---------------------------------------------------------------------
// Conditional ({{if …}}…{{else}}…{{endif}}) validation — client-safe so
// the builder and the publish gate share it. Checks per LINE:
//   • every {{if is consumed by a full, well-formed conditional
//   • no orphan {{else}} / {{endif}}
//   • the condition field is a known TEXT token (not barcode/symbols)
// The regexes live in schema.ts (IF_RE / CONTROL_RE).
// ---------------------------------------------------------------------

export function validateLineConditionals(
  line: string,
  ifRe: RegExp,
  controlRe: RegExp,
): string[] {
  const errs: string[] = [];
  let consumed = line;
  const conds: Array<{ field: string }> = [];
  consumed = consumed.replace(new RegExp(ifRe.source, "g"), (_m, field) => {
    conds.push({ field });
    return "";
  });
  // Anything control-shaped left over is malformed / orphaned.
  for (const m of consumed.matchAll(new RegExp(controlRe.source, "g"))) {
    errs.push(
      `malformed conditional near "{{${m[1]}}}" — expected {{if field == VALUE}}…{{else}}…{{endif}} on one line`,
    );
  }
  for (const c of conds) {
    const meta = tokenMeta(c.field);
    if (!meta) {
      errs.push(`conditional checks unknown variable "${c.field}"`);
    } else if (meta.kind !== "text") {
      errs.push(`conditional can only check text variables ("${c.field}" is ${meta.kind})`);
    }
  }
  return errs;
}
