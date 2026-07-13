import type { StyleData, SiblingStyle } from "@/lib/pdf/types";
import type { ColumnMapping } from "@/lib/customers/config";
import { tFor } from "@/lib/pdf/templates/base";
import { loadTranslationDictionary, translateComposition, translatePhrase } from "@/lib/translations/lookup";
import { loadCareLabels } from "@/lib/care-labels";
import { isCareLabelVisible, type PresentSymbol } from "@/lib/care-labels/visibility";
import { getWashcareSymbol, loadWashcareSymbols } from "@/lib/pdf/washcare-symbols";
import { ruleRequiredColumns } from "@/lib/pdf/spec-fields";
import { ORDER_NO_RULE } from "@/lib/pdf/templates/netto-dk-privatelabel/carton-marking";
import { tokenMeta, parseSiblingTokenKey, type BarcodeSource } from "./token-meta";
import { formatCompositionLines } from "./composition";
import {
  calcsInLine,
  evaluateCalc,
  fieldsInCalcExpression,
  parseCalcExpression,
  type CalcFieldCtx,
} from "./calc";
import {
  applyConditionals,
  conditionalsInDef,
  lineWithoutConditionals,
  tokensInDef,
  tokensInLine,
  type LayoutDef,
  type TokenRef,
} from "./schema";
import { isPinnableField, type PinnableField } from "@/lib/pdf/pins-meta";

// =====================================================
// Token resolvers — the SERVER half of the layout variable system
// (client-safe metadata lives in token-meta.ts). Every token maps onto
// the canonical StyleData (src/lib/pdf/types.ts), the same object every
// coded template receives, so layouts can never drift from what the
// rest of the pipeline renders.
//
// Conditionals ({{if field == VALUE}}…{{else}}…{{endif}}) are evaluated
// per line BEFORE token resolution — the renderer evaluates them against
// StyleData, readiness against the mapped columns, both through
// schema.ts's applyConditionals so the rule semantics are shared.
// =====================================================

// The carton EAN sentinel the PO scraper writes when no EAN was found.
const EAN_SENTINEL = "0000000000000";

type TextResolver = (style: StyleData, arg?: string) => string;

const RESOLVERS: Record<string, TextResolver> = {
  styleName: (s) => s.styleName,
  styleNumber: (s) => s.styleNumber,
  // Bare {{style}} — the base style's identifier (its number); the
  // single-style branch of a {{if multipleStyles == true}}…{{else}}{{style}}…
  // carton template. Same value as {{style1}}; {{style2}}+ are the siblings.
  style: (s) => s.styleNumber,
  // Multi-style mode flag — "true" ONLY on a one-off multi-style carton
  // print (the operator picked siblings in the carton dialog); "" on
  // standard generation. Drives {{if multipleStyles == true}}… so one
  // carton layout can render single normally and multi on a manual print.
  multipleStyles: (s) => (s.multipleStyles ? "true" : ""),
  customerName: (s) => s.customerName,
  // Same fallback chain the Netto carton template uses: Description
  // column → EN product name → style name.
  description: (s) => s.description || tFor(s.productNameTranslations, "en") || s.styleName,
  customerItemNo: (s) => s.customerItemNo ?? "",
  countryOfOrigin: (s) => s.countryOfOrigin ?? "",
  // The style's declared certifications (Monday "certifications__1"
  // column), joined — and the usual field for
  // {{if certificates includes FSC}} conditionals (per-item match).
  certificates: (s) => (s.certificates ?? []).join(", "),
  colourName: (s) => s.colour?.name ?? "",
  colourCode: (s) => s.colour?.code ?? "",
  productGroup: (s) => s.productGroup ?? "",
  campaignWeek: (s) => s.campaignWeek ?? "",
  sizes: (s) => s.sizes.map((x) => x.label).filter(Boolean).join(", "),
  // First size label — inside a repeat-per-EAN repetition the renderer
  // narrows style.sizes to the current row, so this IS the current size.
  size: (s) => s.sizes[0]?.label ?? "",
  sizeRange: (s) => {
    const labels = s.sizes.map((x) => x.label).filter(Boolean);
    if (labels.length === 0) return "";
    if (labels.length === 1) return labels[0];
    return `${labels[0]}–${labels[labels.length - 1]}`;
  },
  // Every size in the run joined by " - " (the full pre-repetition list,
  // preserved on allSizes). The renderer draws this specially so the
  // CURRENT repetition's size is enlarged; this plain value backs
  // readiness / show-values / file names.
  sizeRangeCoop: (s) =>
    (s.allSizes ?? s.sizes)
      .map((x) => x.label)
      .filter(Boolean)
      .join(" - "),
  price: (s) =>
    s.price
      ? `${s.price.amount.toFixed(2)}${s.price.currency ? ` ${s.price.currency}` : ""}`
      : "",

  poNumber: (s) => s.poNumber ?? "",
  customerOrderNo: (s) => s.customerOrderNo ?? "",
  // Raw delivery term off the style ("FOB", "DDP", …) — also the usual
  // field for {{if deliveryTerm == FOB}} conditionals.
  deliveryTerm: (s) => s.deliveryTerm ?? "",
  // FOB → customer's order number; otherwise (DDP / DDU / DAP / empty) →
  // Contrast PO. Mirrors the Netto carton-marking template exactly.
  orderNo: (s) => {
    const isFob = (s.deliveryTerm ?? "").toUpperCase().includes("FOB");
    return (isFob ? s.customerOrderNo : s.poNumber) ?? "";
  },
  qtyPerCarton: (s) => (s.carton.outerVE ? String(s.carton.outerVE) : ""),
  cartonEan: (s) => (s.carton.ean13 && s.carton.ean13 !== EAN_SENTINEL ? s.carton.ean13 : ""),
  assortEan: (s) =>
    s.carton.assortEan && s.carton.assortEan !== EAN_SENTINEL ? s.carton.assortEan : "",
  isAssortment: (s) => (s.isAssortment ? "1" : ""),
  ean13: (s) => s.sizes.find((x) => x.ean13)?.ean13 ?? "",
  batchNo: (s) => s.batchNo ?? "",
  prodNumber: (s) => s.prodNumber ?? "",
  lot: (s) => s.carton.lot ?? "",
  klNumber: (s) => s.carton.klNumber ?? "",
  supplierNumber: (s) => s.carton.supplierNumber ?? "",

  // Carton serial — set per carton by the carton-prints endpoint; empty
  // on standard renders so the line drops out (production mode). Not in
  // REQUIRED_COLUMNS by design: they depend on no mapped column, so an
  // eligible layout's STANDARD output never gates on them.
  cartonNo: (s) => (s.cartonSerial ? String(s.cartonSerial.no) : ""),
  cartonTotal: (s) => (s.cartonSerial ? String(s.cartonSerial.total) : ""),
  cartonNoPadded: (s) =>
    s.cartonSerial ? String(s.cartonSerial.no).padStart(String(s.cartonSerial.total).length, "0") : "",

  // Multi-part garments ("Outer: … Inner: …") arrive on one line from
  // Monday but print one part per line — formatCompositionLines splits on
  // the "<word>:" label boundary (translated, so language-agnostic). Single
  // compositions pass through untouched. The renderer draws the "\n" via
  // .ol-line's pre-wrap. See ./composition.
  composition: (s, arg) => formatCompositionLines(tFor(s.composition, (arg ?? "en").toLowerCase())),
  // "Made in <country>" per language — values are precomputed by
  // augmentTranslatedFields (translation bank), carried on a side-channel
  // field; unaugmented styles resolve "" (→ unresolved chip in preview).
  madeIn: (s, arg) =>
    (s as StyleData & { madeInByLang?: Record<string, string> }).madeInByLang?.[
      (arg ?? "en").toLowerCase()
    ] ?? "",
  // "Made in" / "Manufacturer" labels and the bare country name, each
  // translated per language straight from the translation bank (board is
  // the single source of truth). Precomputed by augmentTranslatedFields
  // onto side-channel fields; unaugmented styles resolve "".
  madeInLabel: (s, arg) =>
    (s as StyleData & { madeInLabelByLang?: Record<string, string> }).madeInLabelByLang?.[
      (arg ?? "en").toLowerCase()
    ] ?? "",
  country: (s, arg) =>
    (s as StyleData & { countryByLang?: Record<string, string> }).countryByLang?.[
      (arg ?? "en").toLowerCase()
    ] ?? "",
  // The "Country of origin" heading itself, translated per language (the
  // board's "Country of origin" phrase → "Oprindelsesland" / "Herkunftsland"
  // / …). A constant label like {{madeInLabel}} / {{manufacturer}} — no
  // column gate; precomputed by augmentTranslatedFields.
  countryOfOriginLabel: (s, arg) =>
    (s as StyleData & { countryOfOriginLabelByLang?: Record<string, string> }).countryOfOriginLabelByLang?.[
      (arg ?? "en").toLowerCase()
    ] ?? "",
  manufacturer: (s, arg) =>
    (s as StyleData & { manufacturerByLang?: Record<string, string> }).manufacturerByLang?.[
      (arg ?? "en").toLowerCase()
    ] ?? "",
  productName: (s, arg) => tFor(s.productNameTranslations, (arg ?? "en").toLowerCase()),
  careInstructions: (s, arg) => s.careInstructionsByLang?.[(arg ?? "en").toLowerCase()] ?? "",

  // Text representation of the wash-care symbol tokens (the renderer
  // draws the actual artwork; this backs show-values + unresolved checks).
  washSymbols: (s) => s.washSymbols.join(", "),
};

// ---------------------------------------------------------------------
// Sibling styles — the {{style2}}/{{style3Name}}… slot tokens. A slot's
// field suffix (canonical-cased by parseSiblingTokenKey) maps here to one
// SiblingStyle field; the empty suffix is the bare {{styleN}} headline
// (the style number). Keep the suffixes in sync with SIBLING_FIELDS
// (token-meta.ts). projectSiblingStyle builds a SiblingStyle from a fully
// mapped StyleData using the SAME base resolvers, so a sibling can never
// drift from how the style would render on its own.
// ---------------------------------------------------------------------
const SIBLING_FIELD_RESOLVERS: Record<string, (s: SiblingStyle) => string> = {
  "": (s) => s.styleNumber,
  number: (s) => s.styleNumber,
  name: (s) => s.styleName,
  description: (s) => s.description,
  customeritemno: (s) => s.customerItemNo,
  colourname: (s) => s.colourName,
  colourcode: (s) => s.colourCode,
  sizes: (s) => s.sizes,
  sizerange: (s) => s.sizeRange,
  qtypercarton: (s) => s.qtyPerCarton,
  cartonean: (s) => s.cartonEan,
  ean13: (s) => s.ean13,
};

export function projectSiblingStyle(style: StyleData, id: string): SiblingStyle {
  return {
    id,
    styleNumber: resolveTextToken(style, "styleNumber"),
    styleName: resolveTextToken(style, "styleName"),
    description: resolveTextToken(style, "description"),
    customerItemNo: resolveTextToken(style, "customerItemNo"),
    colourName: resolveTextToken(style, "colourName"),
    colourCode: resolveTextToken(style, "colourCode"),
    sizes: resolveTextToken(style, "sizes"),
    sizeRange: resolveTextToken(style, "sizeRange"),
    qtyPerCarton: resolveTextToken(style, "qtyPerCarton"),
    cartonEan: resolveTextToken(style, "cartonEan"),
    ean13: resolveTextToken(style, "ean13"),
  };
}

// The SiblingStyle for a slot ("style2…" → siblings[0]); slot 1 is the
// base style itself. Returns null when the slot has no sibling (renders
// empty per the caller's gap rules). Slots ≥ 2 resolve ONLY in multi-style
// mode (style.multipleStyles) — the sibling POOL is always on StyleData, so
// without this gate {{style2}} would leak siblings into standard generation.
// Slot 1 (the base) always resolves, so {{style}}/{{style1}} stay available
// in the single-style branch.
function siblingForSlot(style: StyleData, slot: number): SiblingStyle | null {
  if (slot <= 1) return projectSiblingStyle(style, "self");
  if (!style.multipleStyles) return null;
  return style.siblings?.[slot - 2] ?? null;
}

// Resolve a TEXT token to its string value ("" when empty/unknown —
// callers decide how to surface gaps). Barcode/symbol tokens are drawn
// by the renderer; their resolvers here return the underlying value.
export function resolveTextToken(style: StyleData, key: string, arg?: string): string {
  // Sibling slot tokens resolve against StyleData.siblings (sync — the
  // pool is pre-fetched in buildStyleData). They take no :arg.
  const sib = parseSiblingTokenKey(key);
  if (sib) {
    if (arg) return "";
    const target = siblingForSlot(style, sib.slot);
    if (!target) return "";
    const fn = SIBLING_FIELD_RESOLVERS[sib.suffix.toLowerCase()];
    return fn ? (fn(target) ?? "").trim() : "";
  }
  const fn = RESOLVERS[key];
  if (!fn) return "";
  return (fn(style, arg) ?? "").trim();
}

// Barcode source value off StyleData ("" when absent).
export function resolveBarcodeValue(style: StyleData, source: BarcodeSource): string {
  if (source === "cartonEan") return resolveTextToken(style, "cartonEan");
  // assortEan (Code128/EAN-128) and assortEan13 (true EAN-13) print the SAME
  // master-carton value — only the symbology differs (see barcodeSymbology).
  if (source === "assortEan" || source === "assortEan13") return resolveTextToken(style, "assortEan");
  return resolveTextToken(style, "ean13");
}

// Evaluate one line's conditionals against StyleData (render-side rule).
export function applyConditionalsForStyle(line: string, style: StyleData): string {
  return applyConditionals(line, (field) => resolveTextToken(style, field));
}

// ---------------------------------------------------------------------
// Calculated fields ({{= …}}) against StyleData. Direct field references
// go through resolveTextToken (so sibling slot keys keep their multi-style
// gate); aggregates walk the base style + the ACTIVE siblings via the SAME
// per-slot projection the {{styleN…}} tokens use, so sum(qtyPerCarton) can
// never disagree with what {{style2QtyPerCarton}} would print.
// ---------------------------------------------------------------------

function calcCtxForStyle(style: StyleData): CalcFieldCtx {
  return {
    field: (key) => resolveTextToken(style, key),
    aggregate: (suffix) => {
      const fn = SIBLING_FIELD_RESOLVERS[suffix.toLowerCase()];
      if (!fn) return { base: "", siblings: [] };
      const base = (fn(projectSiblingStyle(style, "self")) ?? "").trim();
      const pool = style.multipleStyles ? (style.siblings ?? []) : [];
      return { base, siblings: pool.map((s) => (fn(s) ?? "").trim()) };
    },
  };
}

// Formatted result of one calc expression on this style, or null =
// unresolved (missing base data, bad expression, division by zero).
export function evaluateCalcForStyle(expr: string, style: StyleData): string | null {
  const parsed = parseCalcExpression(expr);
  if (!parsed.ast) return null;
  return evaluateCalc(parsed.ast, calcCtxForStyle(style));
}

// ---------------------------------------------------------------------
// Readiness: which mapped columns a token needs before an output that
// uses it counts as "ready" (template-registry requiredFields /
// readiness semantics — see output-readiness.ts).
// ---------------------------------------------------------------------

// Static column gates per token. Tokens absent here (styleName,
// customerName, careInstructions, deliveryTerm, …) need no mapped column
// — they come from the Customer record, the ProdSpec, or are legitimate
// when empty (an empty delivery term means DDP).
const REQUIRED_COLUMNS: Record<string, Array<keyof ColumnMapping>> = {
  styleNumber: ["styleNumber"],
  description: ["description"],
  customerItemNo: ["customerItemNo"],
  countryOfOrigin: ["countryOfOrigin"],
  colourName: ["colourName"],
  colourCode: ["colourCode"],
  productGroup: ["productGroup"],
  campaignWeek: ["campaignWeek"],
  certificates: ["certificates"],
  sizes: ["sizes"],
  size: ["sizes"],
  sizeRange: ["sizes"],
  sizeRangeCoop: ["sizes"],
  price: ["price"],
  poNumber: ["poNumber"],
  customerOrderNo: ["customerOrderNo"],
  qtyPerCarton: ["cartonQty"],
  cartonEan: ["cartonEan"],
  assortEan: ["assortEan"],
  ean13: ["ean13"],
  batchNo: ["batchNo"],
  prodNumber: ["prodNumber"],
  lot: ["lot"],
  klNumber: ["klNumber"],
  supplierNumber: ["supplierNumber"],
  composition: ["composition"],
  madeIn: ["countryOfOrigin"],
  // The bare translated country name needs the same column as madeIn; the
  // "Made in" / "Manufacturer" labels are constants (no column gate).
  country: ["countryOfOrigin"],
  washSymbols: ["washCare"],
  // The condition field itself: resolvable at readiness time via this
  // column, but never REQUIRED (empty = DDP, a valid state).
  deliveryTerm: [],
};

// Column a condition field reads at readiness time (deliveryTerm →
// "deliveryTerm" even though it isn't a required column).
const CONDITION_COLUMN: Partial<Record<string, keyof ColumnMapping>> = {
  deliveryTerm: "deliveryTerm",
};

function columnsForToken(ref: TokenRef): Array<keyof ColumnMapping> {
  if (ref.key === "barcode") {
    if (ref.arg === "cartonEan") return ["cartonEan"];
    if (ref.arg === "assortEan" || ref.arg === "assortEan13") return ["assortEan"];
    if (ref.arg === "ean13") return ["ean13"];
    return [];
  }
  return REQUIRED_COLUMNS[ref.key] ?? [];
}

// The PINNABLE fields a layout actually prints — every token's backing
// column(s) that are in the pin vocabulary. Drives the review-time field
// editor's pre-filled inputs (structured/derived columns like sizes/ean13/
// washCare/price aren't pinnable, so they fall out). Deduped, definition order.
export function pinnableFieldsInDef(def: LayoutDef): PinnableField[] {
  const out: PinnableField[] = [];
  const seen = new Set<string>();
  for (const ref of tokensInDef(def)) {
    for (const col of columnsForToken(ref)) {
      if (isPinnableField(col) && !seen.has(col)) {
        seen.add(col);
        out.push(col);
      }
    }
  }
  return out;
}

function conditionColumn(field: string): keyof ColumnMapping | null {
  return CONDITION_COLUMN[field] ?? REQUIRED_COLUMNS[field]?.[0] ?? null;
}

// Token refs that render UNCONDITIONALLY (conditional branches stripped).
function staticTokenRefs(def: LayoutDef): TokenRef[] {
  const out: TokenRef[] = [];
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        out.push(...tokensInLine(lineWithoutConditionals(line)));
      }
    }
  }
  return out;
}

// Mapped columns one calc expression's inputs need. Direct base fields
// and aggregate base fields gate like the bare token would (sum(
// qtyPerCarton) needs the cartonQty column); sibling references depend on
// OTHER styles, never on this style's columns — same rule as the
// {{styleN…}} tokens. {{orderNo}} is branch-dependent and excluded here,
// mirroring the plain-token walks (it's non-numeric anyway).
function calcRequiredColumns(expr: string): Array<keyof ColumnMapping> {
  const { fields, aggregates } = fieldsInCalcExpression(expr);
  const out: Array<keyof ColumnMapping> = [];
  for (const key of [...fields, ...aggregates]) {
    if (parseSiblingTokenKey(key) || key === "orderNo") continue;
    out.push(...(REQUIRED_COLUMNS[key] ?? []));
  }
  return out;
}

// Static required columns across a whole definition — the layout
// variant's `requiredFields`. Branch-dependent content ({{orderNo}},
// anything inside {{if}}…{{endif}}) is excluded here;
// layoutReadinessColumns adds the taken branches per style.
export function staticRequiredColumns(def: LayoutDef): Array<keyof ColumnMapping> {
  const out = new Set<keyof ColumnMapping>();
  for (const ref of staticTokenRefs(def)) {
    if (ref.key === "orderNo") continue;
    for (const c of columnsForToken(ref)) out.add(c);
  }
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const expr of calcsInLine(lineWithoutConditionals(line))) {
          for (const c of calcRequiredColumns(expr)) out.add(c);
        }
      }
    }
  }
  return [...out];
}

export function defUsesOrderNo(def: LayoutDef): boolean {
  return staticTokenRefs(def).some((r) => r.key === "orderNo");
}

// Does readiness need per-style branch evaluation? True when the def
// uses {{orderNo}} anywhere or contains conditionals.
export function defNeedsDynamicReadiness(def: LayoutDef): boolean {
  if (conditionalsInDef(def).length > 0) return true;
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        if (tokensInLine(line).some((r) => r.key === "orderNo")) return true;
      }
    }
  }
  return false;
}

// Branch-aware readiness — the columns the TAKEN content actually needs
// on this style. Conditionals are evaluated with the mapped-column
// resolver (the same rule semantics the renderer applies to StyleData;
// condition fields without a mapped column resolve "" here — keep
// conditions on column-backed fields like deliveryTerm).
export function layoutReadinessColumns(
  def: LayoutDef,
  resolve: (field: keyof ColumnMapping) => string,
): Array<keyof ColumnMapping> {
  const getValue = (field: string) => {
    const col = conditionColumn(field);
    return col ? resolve(col) : "";
  };
  const out = new Set<keyof ColumnMapping>();
  let usesOrderNo = false;
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const effective = applyConditionals(line, getValue);
        for (const ref of tokensInLine(effective)) {
          if (ref.key === "orderNo") {
            usesOrderNo = true;
            continue;
          }
          for (const c of columnsForToken(ref)) out.add(c);
        }
        for (const expr of calcsInLine(effective)) {
          for (const c of calcRequiredColumns(expr)) out.add(c);
        }
      }
    }
  }
  if (usesOrderNo) {
    // FOB → customerOrderNo, else poNumber — reuses the carton-marking
    // ORDER_NO_RULE so builder layouts and the coded template can never
    // disagree on the rule.
    for (const c of ruleRequiredColumns(ORDER_NO_RULE, resolve)) out.add(c);
  }
  return [...out];
}

// Tokens in the def's TAKEN content that resolve empty on this style —
// the builder's "missing on this style" list (and the preview's amber
// chips). Returns the printable token strings.
export function unresolvedTokens(def: LayoutDef, style: StyleData): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        const effective = applyConditionalsForStyle(line, style);
        // Calcs surface as one amber gap when they can't produce a value —
        // a missing BASE input (empty sibling slots coerce to 0 and never
        // trip this). Malformed expressions land here too, but publish
        // validation catches those with a precise message first.
        for (const expr of calcsInLine(effective)) {
          if (evaluateCalcForStyle(expr, style) === null) {
            const printable = `{{= ${expr} }}`;
            if (!seen.has(printable)) {
              seen.add(printable);
              out.push(printable);
            }
          }
        }
        for (const ref of tokensInLine(effective)) {
          const meta = tokenMeta(ref.key);
          if (!meta) continue;
          // Sibling slot tokens ({{style2}}…) depend on OTHER styles on the
          // PO, not this style's columns — an empty slot is never a "missing
          // field" on the style being built. {{multipleStyles}} is a mode
          // flag that's legitimately "" in single-style mode. Don't list
          // either as amber gaps.
          if (parseSiblingTokenKey(ref.key) || ref.key === "multipleStyles") continue;
          // Image tokens (logos, certification marks) always render
          // something: present → the artwork, absent → a visible chip on
          // the proof counted by the ship gate. This sync check can't see
          // the fs/db-backed artwork anyway, so listing them here would
          // be permanent amber noise in the builder.
          if (meta.kind === "image") continue;
          const value =
            meta.kind === "barcode"
              ? resolveBarcodeValue(style, (ref.arg ?? "cartonEan") as BarcodeSource)
              : resolveTextToken(style, ref.key, ref.arg);
          if (!value) {
            const printable = `{{${ref.key}${ref.arg ? `:${ref.arg}` : ""}}}`;
            if (!seen.has(printable)) {
              seen.add(printable);
              out.push(printable);
            }
          }
        }
      }
    }
  }
  return out;
}

// Resolve a Settings fileName expression against a style: text tokens
// substituted, then slug-sanitised. Returns null when the expression is
// empty (caller falls back to the runner default).
export function resolveLayoutFileName(expr: string, style: StyleData): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const replaced = trimmed.replace(
    /\{\{([a-zA-Z][a-zA-Z0-9]*)(?::([a-zA-Z0-9-]+))?\}\}/g,
    (_m, key, arg) => resolveTextToken(style, key, arg || undefined),
  );
  const slug = replaced
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return slug ? `${slug}.pdf` : null;
}

// ---------------------------------------------------------------------
// Composition translations — {{composition:da}} etc. resolve through the
// translation bank exactly like the coded care labels do: the style's
// ENGLISH composition is the source, fibre names are matched against the
// Translation rows (translateComposition preserves percentages and
// punctuation), and a missing bank entry degrades to the English fibre
// rather than an empty line. The augmented entries are appended to
// style.composition so the ordinary sync resolvers (render, unresolved,
// show-values) just work.
// ---------------------------------------------------------------------

export function compositionLangsInDef(def: LayoutDef): string[] {
  const langs = new Set<string>();
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const ref of tokensInLine(line)) {
          if (ref.key === "composition" && ref.arg) langs.add(ref.arg.toLowerCase());
        }
      }
    }
  }
  return [...langs];
}

export async function augmentCompositionTranslations(
  style: StyleData,
  langs: string[],
): Promise<StyleData> {
  const source = tFor(style.composition, "en") || style.composition[0]?.text || "";
  if (!source) return style;
  const missing = langs.filter((l) => l !== "en" && !tFor(style.composition, l).trim());
  if (missing.length === 0) return style;
  const dict = await loadTranslationDictionary();
  const added = missing.map((lang) => ({
    language: lang,
    text: translateComposition(dict, source, lang).text,
  }));
  return { ...style, composition: [...style.composition, ...added] };
}

// ---------------------------------------------------------------------
// Per-language fields resolved through the translation bank, precomputed
// onto side-channel maps so the sync resolvers above just read them.
// Care instructions are the standard catalogue (CareLabel rows) FILTERED
// BY THE STYLE'S WASH-CARE SYMBOLS (isCareLabelVisible — prohibition
// symbols drop their action's lines), each line translated via the bank,
// joined " / " — exactly the care-label-02 derivation; a non-empty
// ProdSpec careInstructionsByLang entry overrides it. {{madeIn}} resolves
// the full "Made in <country>" phrase; {{madeInLabel}} / {{manufacturer}}
// the bare labels; {{country}} the translated country name.
// ---------------------------------------------------------------------

export function langArgsInDef(def: LayoutDef, tokenKey: string): string[] {
  const langs = new Set<string>();
  for (const page of def.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const ref of tokensInLine(line)) {
          if (ref.key === tokenKey && ref.arg) langs.add(ref.arg.toLowerCase());
        }
      }
    }
  }
  return [...langs];
}

// The per-language sets a layout needs precomputed, gathered with
// langArgsInDef(def, "<key>") at the call site. Each maps to the matching
// token: {{careInstructions}}, {{madeIn}}, {{madeInLabel}}, {{country}},
// {{manufacturer}}.
export type TranslatedFieldLangs = {
  care?: string[];
  madeIn?: string[];
  madeInLabel?: string[];
  country?: string[];
  countryOfOriginLabel?: string[];
  manufacturer?: string[];
};

export async function augmentTranslatedFields(
  style: StyleData,
  langs: TranslatedFieldLangs,
): Promise<StyleData> {
  const careLangs = langs.care ?? [];
  const madeInLangs = langs.madeIn ?? [];
  const madeInLabelLangs = langs.madeInLabel ?? [];
  const countryLangs = langs.country ?? [];
  const countryOfOriginLabelLangs = langs.countryOfOriginLabel ?? [];
  const manufacturerLangs = langs.manufacturer ?? [];

  type Carried = StyleData & {
    madeInByLang?: Record<string, string>;
    madeInLabelByLang?: Record<string, string>;
    countryByLang?: Record<string, string>;
    countryOfOriginLabelByLang?: Record<string, string>;
    manufacturerByLang?: Record<string, string>;
  };
  const carried = style as Carried;
  const carriedMadeIn = carried.madeInByLang ?? {};
  const carriedMadeInLabel = carried.madeInLabelByLang ?? {};
  const carriedCountry = carried.countryByLang ?? {};
  const carriedCountryOfOriginLabel = carried.countryOfOriginLabelByLang ?? {};
  const carriedManufacturer = carried.manufacturerByLang ?? {};

  const country = (style.countryOfOrigin ?? "").trim();

  const needsCare = careLangs.some((l) => !(style.careInstructionsByLang?.[l] ?? "").trim());
  const needsMadeIn = country !== "" && madeInLangs.some((l) => !(carriedMadeIn[l] ?? "").trim());
  const needsMadeInLabel = madeInLabelLangs.some((l) => !(carriedMadeInLabel[l] ?? "").trim());
  const needsCountry = country !== "" && countryLangs.some((l) => !(carriedCountry[l] ?? "").trim());
  const needsCountryOfOriginLabel = countryOfOriginLabelLangs.some(
    (l) => !(carriedCountryOfOriginLabel[l] ?? "").trim(),
  );
  const needsManufacturer = manufacturerLangs.some((l) => !(carriedManufacturer[l] ?? "").trim());
  if (
    !needsCare &&
    !needsMadeIn &&
    !needsMadeInLabel &&
    !needsCountry &&
    !needsCountryOfOriginLabel &&
    !needsManufacturer
  ) {
    return style;
  }

  // One dictionary load powers every per-language field below (care also
  // needs the catalogue + wash symbols to filter visible lines).
  const [labels, dict, symbolMap] = await Promise.all([
    needsCare ? loadCareLabels() : Promise.resolve([]),
    loadTranslationDictionary(),
    needsCare ? loadWashcareSymbols() : Promise.resolve(null),
  ]);

  const careByLang: Record<string, string> = { ...(style.careInstructionsByLang ?? {}) };
  if (needsCare && symbolMap) {
    const present: PresentSymbol[] = style.washSymbols.map((token) => {
      const resolved = getWashcareSymbol(symbolMap, token);
      return resolved
        ? { code: resolved.code, action: resolved.action, restrictive: resolved.restrictive }
        : { code: token, action: null, restrictive: false };
    });
    const visible = labels.filter((l) => isCareLabelVisible(l, present));
    for (const lang of careLangs) {
      if ((careByLang[lang] ?? "").trim()) continue; // ProdSpec override wins
      careByLang[lang] = visible
        .map((l) => translatePhrase(dict, l.sourceText, lang).trim())
        .filter(Boolean)
        .join(" / ");
    }
  }

  // Made in <country> (full phrase) — kept for the existing {{madeIn}}.
  const madeInByLang: Record<string, string> = { ...carriedMadeIn };
  if (country) {
    for (const lang of madeInLangs) {
      if ((madeInByLang[lang] ?? "").trim()) continue;
      madeInByLang[lang] = translatePhrase(dict, `Made in ${country}`, lang);
    }
  }

  // Split fields: the "Made in" / "Manufacturer" labels are constants
  // translated per language; the country name translates the style's
  // country of origin. All three flow from the translation board, so a
  // phrase the board doesn't carry degrades to English (like {{madeIn}}).
  const madeInLabelByLang: Record<string, string> = { ...carriedMadeInLabel };
  for (const lang of madeInLabelLangs) {
    if ((madeInLabelByLang[lang] ?? "").trim()) continue;
    madeInLabelByLang[lang] = translatePhrase(dict, "Made in", lang);
  }

  const countryByLang: Record<string, string> = { ...carriedCountry };
  if (country) {
    for (const lang of countryLangs) {
      if ((countryByLang[lang] ?? "").trim()) continue;
      countryByLang[lang] = translatePhrase(dict, country, lang);
    }
  }

  // The "Country of origin" heading — a constant label translated straight
  // from the board (degrades to English when the board lacks the language),
  // independent of whether the style carries a country value.
  const countryOfOriginLabelByLang: Record<string, string> = { ...carriedCountryOfOriginLabel };
  for (const lang of countryOfOriginLabelLangs) {
    if ((countryOfOriginLabelByLang[lang] ?? "").trim()) continue;
    countryOfOriginLabelByLang[lang] = translatePhrase(dict, "Country of origin", lang);
  }

  const manufacturerByLang: Record<string, string> = { ...carriedManufacturer };
  for (const lang of manufacturerLangs) {
    if ((manufacturerByLang[lang] ?? "").trim()) continue;
    manufacturerByLang[lang] = translatePhrase(dict, "Manufacturer", lang);
  }

  return {
    ...style,
    careInstructionsByLang: careByLang,
    madeInByLang,
    madeInLabelByLang,
    countryByLang,
    countryOfOriginLabelByLang,
    manufacturerByLang,
  } as StyleData;
}
