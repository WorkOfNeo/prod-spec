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
  group: "Style" | "Order & carton" | "Per language" | "Barcodes & symbols" | "Sibling styles";
  kind: LayoutTokenKind;
  // "lang" → the token takes a language argument ({{composition:da}});
  // "source" → barcode/logo source argument ({{barcode:cartonEan}});
  // "gap" → optional numeric mm gap, e.g. {{washSymbols:0}} (0 mm gap).
  arg?: "lang" | "source" | "gap";
  // Example value shown in the palette tooltip.
  example?: string;
};

export const LAYOUT_TOKENS: LayoutTokenMeta[] = [
  // ---- Style ----
  { key: "styleName", label: "Style name", group: "Style", kind: "text", example: "2044 PAW PATROL TEE" },
  { key: "styleNumber", label: "Style number", group: "Style", kind: "text", example: "IL97261" },
  {
    key: "style",
    label: "Style (number) — single-style branch of {{if multipleStyles == true}}",
    group: "Style",
    kind: "text",
    example: "IL97261",
  },
  { key: "customerName", label: "Customer name", group: "Style", kind: "text", example: "Netto A/S" },
  { key: "description", label: "Description", group: "Style", kind: "text", example: "T-Shirt Paw Patrol – Blue" },
  { key: "customerItemNo", label: "Customer item no", group: "Style", kind: "text", example: "223609" },
  { key: "countryOfOrigin", label: "Country of origin", group: "Style", kind: "text", example: "India" },
  {
    key: "certificates",
    label: "Certificates the style declares (also for {{if certificates includes FSC}})",
    group: "Style",
    kind: "text",
    example: "FSC, OEKOTEX",
  },
  { key: "colourName", label: "Colour name", group: "Style", kind: "text", example: "Navy" },
  { key: "colourCode", label: "Colour code", group: "Style", kind: "text", example: "19-3920" },
  { key: "productGroup", label: "Product group", group: "Style", kind: "text", example: "3-Pack Socks" },
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
  {
    key: "sizeRangeCoop",
    label: "Size range, current size enlarged (Coop)",
    group: "Style",
    kind: "text",
    example: "86/92 - 98/104 - 110/116",
  },
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
  { key: "assortEan", label: "Assortment EAN (number)", group: "Order & carton", kind: "text", example: "5701234567890" },
  {
    key: "isAssortment",
    label: 'Assortment-row flag — use as {{if isAssortment == 1}}…{{else}}…{{endif}} (repeatBy "assort")',
    group: "Order & carton",
    kind: "text",
    example: "1",
  },
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
  // Carton numbering (X of Y) — only resolve on a MANUAL numbered-print
  // run (StyleData.cartonSerial); empty on standard generation. Enable
  // "Carton numbering" in the layout's Settings to use these.
  { key: "cartonNo", label: "Carton no (this print)", group: "Order & carton", kind: "text", example: "7" },
  { key: "cartonTotal", label: "Carton total", group: "Order & carton", kind: "text", example: "200" },
  {
    key: "cartonNoPadded",
    label: "Carton no (zero-padded to total)",
    group: "Order & carton",
    kind: "text",
    example: "007",
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
  {
    key: "madeInLabel",
    label: "Made in (label only, translated)",
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "Fremstillet i",
  },
  {
    key: "country",
    label: "Country of origin (translated)",
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "Kina",
  },
  {
    key: "countryOfOriginLabel",
    label: 'Country of origin ("Country of origin" label, translated)',
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "Oprindelsesland",
  },
  {
    key: "manufacturer",
    label: "Manufacturer (label, translated)",
    group: "Per language",
    kind: "text",
    arg: "lang",
    example: "Producent",
  },

  // ---- Barcodes & symbols (rendered as graphics, scaled by block font size) ----
  { key: "barcode", label: "Barcode", group: "Barcodes & symbols", kind: "barcode", arg: "source", example: "{{barcode:cartonEan}}" },
  {
    key: "washSymbols",
    label: "Wash care symbols (optional gap in mm, e.g. {{washSymbols:0}})",
    group: "Barcodes & symbols",
    kind: "symbols",
    arg: "gap",
    example: "{{washSymbols}}",
  },
  {
    key: "logo",
    label: "Logo (contrast / contrastAddress = repo files, custom = uploaded)",
    group: "Barcodes & symbols",
    kind: "image",
    arg: "source",
    example: "{{logo:contrast}}",
  },
  {
    key: "cert",
    label:
      "Certification mark — prints only on styles whose Certificates field declares it (artwork from Settings → Certificates)",
    group: "Barcodes & symbols",
    kind: "image",
    arg: "source",
    example: "{{cert:oekotex}}",
  },

  // ---- Sibling styles (Custom Carton Marking) ----
  // The slot tokens ({{style2}}, {{style3Name}}…) are recognised
  // dynamically by parseSiblingTokenKey; only this mode flag is static.
  {
    key: "multipleStyles",
    label: 'Multi-style mode flag — use as {{if multipleStyles == true}}…{{else}}…{{endif}} (== not ===)',
    group: "Sibling styles",
    kind: "text",
    example: "true",
  },
];

// cartonEan / assortEan print as EAN-128 (Code128); assortEan13 prints the
// SAME master-carton value as a true EAN-13 — so a layout can pick the
// symbology. ean13 is the per-size product barcode.
export const BARCODE_SOURCES = ["cartonEan", "assortEan", "assortEan13", "ean13"] as const;
export type BarcodeSource = (typeof BARCODE_SOURCES)[number];

export const LOGO_SOURCES = ["contrast", "contrastAddress", "custom"] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

// Certification marks resolvable by {{cert:…}} — each needs a row in the
// Certificate library (Settings → Certificates) whose name normalizes to
// the source key ("OEKO-TEX" → "oekotex", see normalizeCertKey). Adding a
// mark = one entry here + a palette chip + a library row.
export const CERT_SOURCES = ["oekotex", "fsc"] as const;
export type CertSource = (typeof CERT_SOURCES)[number];

// Allowed :arg values for source-typed tokens, per key.
const SOURCES_BY_KEY: Record<string, readonly string[]> = {
  barcode: BARCODE_SOURCES,
  logo: LOGO_SOURCES,
  cert: CERT_SOURCES,
};

// ---------------------------------------------------------------------
// Sibling styles — "Custom Carton Marking". A carton-marking layout can
// place OTHER styles from the SAME PO on the box via slot tokens:
//   {{style2}}            slot 2 — the style number (the headline)
//   {{style2Number}}      slot 2 — style number
//   {{style2Name}} / {{style2Description}} / {{style2ColourName}} / …
// Slot 1 is the base style itself (so a template can render every slot
// uniformly with {{style1…}}/{{style2…}} if it prefers). Slots resolve
// against StyleData.siblings, pre-computed in buildStyleData — the token
// pipeline stays SYNC. Keys are dynamic (slot × field), so tokenMeta /
// resolveTextToken recognise them by pattern rather than a static table.
// ---------------------------------------------------------------------

// Highest slot number a layout / the palette / the permanent config will
// offer. Slot N means up to N styles on one box (1 base + N-1 siblings).
export const MAX_SIBLING_SLOTS = 8;

// The field suffixes a sibling slot exposes. The empty suffix is the bare
// {{styleN}} headline. tokens.ts maps each suffix (case-insensitively) to
// a StyleData field — keep the two in sync.
export const SIBLING_FIELDS: ReadonlyArray<{ suffix: string; label: string }> = [
  { suffix: "", label: "Style (number)" },
  { suffix: "Number", label: "Style number" },
  { suffix: "Name", label: "Style name" },
  { suffix: "Description", label: "Description" },
  { suffix: "CustomerItemNo", label: "Customer item no" },
  { suffix: "ColourName", label: "Colour name" },
  { suffix: "ColourCode", label: "Colour code" },
  { suffix: "Sizes", label: "Sizes" },
  { suffix: "SizeRange", label: "Size range" },
  { suffix: "QtyPerCarton", label: "Qty per carton" },
  { suffix: "CartonEan", label: "Carton EAN" },
  { suffix: "Ean13", label: "EAN-13 (first size)" },
];

// "style" + slot digits + optional field suffix. The digit requirement is
// what keeps this from colliding with the static "styleName"/"styleNumber"
// keys (a letter follows "style" there, never a digit).
const SIBLING_KEY_RE = /^style(\d{1,2})([A-Za-z][A-Za-z0-9]*)?$/;

export type SiblingTokenRef = { slot: number; suffix: string };

// Parse a sibling token key ("style2Number") into { slot, canonical suffix }
// — or null when it isn't one (unknown field suffix, slot out of range, or
// a non-sibling key). The returned suffix is the canonical-cased entry from
// SIBLING_FIELDS so downstream lookups are stable.
export function parseSiblingTokenKey(key: string): SiblingTokenRef | null {
  const m = SIBLING_KEY_RE.exec(key);
  if (!m) return null;
  const slot = Number(m[1]);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SIBLING_SLOTS) return null;
  const raw = m[2] ?? "";
  const field = SIBLING_FIELDS.find((f) => f.suffix.toLowerCase() === raw.toLowerCase());
  if (!field) return null;
  return { slot, suffix: field.suffix };
}

const META_BY_KEY = new Map(LAYOUT_TOKENS.map((t) => [t.key, t]));

export function tokenMeta(key: string): LayoutTokenMeta | null {
  const direct = META_BY_KEY.get(key);
  if (direct) return direct;
  // Sibling slot tokens ({{style2}}, {{style3Name}}…) are synthesised so
  // the renderer treats them as known TEXT tokens and publish validation
  // accepts them.
  const sib = parseSiblingTokenKey(key);
  if (sib) {
    const field = SIBLING_FIELDS.find((f) => f.suffix === sib.suffix);
    return {
      key,
      label: `Style ${sib.slot} · ${field?.label ?? "field"}`,
      group: "Sibling styles",
      kind: "text",
    };
  }
  return null;
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
  // "gap" arg is optional; when present it must be a non-negative mm number
  // (≤ 20 mm — a sane ceiling for a symbol strip gap).
  if (meta.arg === "gap" && arg !== undefined) {
    const n = Number(arg);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      errs.push(`{{${key}:${arg}}} gap must be a number of mm between 0 and 20`);
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
      `malformed conditional near "{{${m[1]}}}" — expected {{if field == VALUE}} or {{if field includes VALUE}} (…{{else}}…){{endif}} on one line`,
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
