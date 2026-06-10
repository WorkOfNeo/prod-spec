import type { StyleData } from "@/lib/pdf/types";
import type { ColumnMapping } from "@/lib/customers/config";
import { tFor } from "@/lib/pdf/templates/base";
import { loadTranslationDictionary, translateComposition } from "@/lib/translations/lookup";
import { ruleRequiredColumns } from "@/lib/pdf/spec-fields";
import { ORDER_NO_RULE } from "@/lib/pdf/templates/netto-dk-privatelabel/carton-marking";
import { tokenMeta, type BarcodeSource } from "./token-meta";
import {
  applyConditionals,
  conditionalsInDef,
  lineWithoutConditionals,
  tokensInLine,
  type LayoutDef,
  type TokenRef,
} from "./schema";

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
  customerName: (s) => s.customerName,
  // Same fallback chain the Netto carton template uses: Description
  // column → EN product name → style name.
  description: (s) => s.description || tFor(s.productNameTranslations, "en") || s.styleName,
  customerItemNo: (s) => s.customerItemNo ?? "",
  countryOfOrigin: (s) => s.countryOfOrigin ?? "",
  colourName: (s) => s.colour?.name ?? "",
  colourCode: (s) => s.colour?.code ?? "",
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
  price: (s) => (s.price ? `${s.price.amount.toFixed(2)} ${s.price.currency}` : ""),

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
  ean13: (s) => s.sizes.find((x) => x.ean13)?.ean13 ?? "",
  batchNo: (s) => s.batchNo ?? "",
  prodNumber: (s) => s.prodNumber ?? "",
  lot: (s) => s.carton.lot ?? "",
  klNumber: (s) => s.carton.klNumber ?? "",
  supplierNumber: (s) => s.carton.supplierNumber ?? "",

  composition: (s, arg) => tFor(s.composition, (arg ?? "en").toLowerCase()),
  productName: (s, arg) => tFor(s.productNameTranslations, (arg ?? "en").toLowerCase()),
  careInstructions: (s, arg) => s.careInstructionsByLang?.[(arg ?? "en").toLowerCase()] ?? "",

  // Text representation of the wash-care symbol tokens (the renderer
  // draws the actual artwork; this backs show-values + unresolved checks).
  washSymbols: (s) => s.washSymbols.join(", "),
};

// Resolve a TEXT token to its string value ("" when empty/unknown —
// callers decide how to surface gaps). Barcode/symbol tokens are drawn
// by the renderer; their resolvers here return the underlying value.
export function resolveTextToken(style: StyleData, key: string, arg?: string): string {
  const fn = RESOLVERS[key];
  if (!fn) return "";
  return (fn(style, arg) ?? "").trim();
}

// Barcode source value off StyleData ("" when absent).
export function resolveBarcodeValue(style: StyleData, source: BarcodeSource): string {
  if (source === "cartonEan") return resolveTextToken(style, "cartonEan");
  return resolveTextToken(style, "ean13");
}

// Evaluate one line's conditionals against StyleData (render-side rule).
export function applyConditionalsForStyle(line: string, style: StyleData): string {
  return applyConditionals(line, (field) => resolveTextToken(style, field));
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
  campaignWeek: ["campaignWeek"],
  sizes: ["sizes"],
  size: ["sizes"],
  sizeRange: ["sizes"],
  price: ["price"],
  poNumber: ["poNumber"],
  customerOrderNo: ["customerOrderNo"],
  qtyPerCarton: ["cartonQty"],
  cartonEan: ["cartonEan"],
  ean13: ["ean13"],
  batchNo: ["batchNo"],
  prodNumber: ["prodNumber"],
  lot: ["lot"],
  klNumber: ["klNumber"],
  supplierNumber: ["supplierNumber"],
  composition: ["composition"],
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
    if (ref.arg === "ean13") return ["ean13"];
    return [];
  }
  return REQUIRED_COLUMNS[ref.key] ?? [];
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
        for (const ref of tokensInLine(effective)) {
          const meta = tokenMeta(ref.key);
          if (!meta) continue;
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
