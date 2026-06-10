import type { StyleData } from "@/lib/pdf/types";
import type { ColumnMapping } from "@/lib/customers/config";
import { tFor } from "@/lib/pdf/templates/base";
import { ruleRequiredColumns } from "@/lib/pdf/spec-fields";
import { ORDER_NO_RULE } from "@/lib/pdf/templates/netto-dk-privatelabel/carton-marking";
import { tokenMeta, type BarcodeSource } from "./token-meta";
import { tokensInDef, type LayoutDef, type TokenRef } from "./schema";

// =====================================================
// Token resolvers — the SERVER half of the layout variable system
// (client-safe metadata lives in token-meta.ts). Every token maps onto
// the canonical StyleData (src/lib/pdf/types.ts), the same object every
// coded template receives, so layouts can never drift from what the
// rest of the pipeline renders.
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
  sizeRange: (s) => {
    const labels = s.sizes.map((x) => x.label).filter(Boolean);
    if (labels.length === 0) return "";
    if (labels.length === 1) return labels[0];
    return `${labels[0]}–${labels[labels.length - 1]}`;
  },
  price: (s) => (s.price ? `${s.price.amount.toFixed(2)} ${s.price.currency}` : ""),

  poNumber: (s) => s.poNumber ?? "",
  customerOrderNo: (s) => s.customerOrderNo ?? "",
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
};

// Resolve a TEXT token to its string value ("" when empty/unknown —
// callers decide how to surface gaps). Barcode tokens are handled by the
// renderer, not here.
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

// ---------------------------------------------------------------------
// Readiness: which mapped columns a token needs before an output that
// uses it counts as "ready" (template-registry requiredFields /
// readiness semantics — see output-readiness.ts).
// ---------------------------------------------------------------------

// Static column gates per token. Tokens absent here (styleName,
// customerName, careInstructions, …) need no mapped column — they come
// from the Customer record, the ProdSpec, or are always present.
const REQUIRED_COLUMNS: Record<string, Array<keyof ColumnMapping>> = {
  styleNumber: ["styleNumber"],
  description: ["description"],
  customerItemNo: ["customerItemNo"],
  countryOfOrigin: ["countryOfOrigin"],
  colourName: ["colourName"],
  colourCode: ["colourCode"],
  campaignWeek: ["campaignWeek"],
  sizes: ["sizes"],
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
};

function columnsForToken(ref: TokenRef): Array<keyof ColumnMapping> {
  if (ref.key === "barcode") {
    if (ref.arg === "cartonEan") return ["cartonEan"];
    if (ref.arg === "ean13") return ["ean13"];
    return [];
  }
  return REQUIRED_COLUMNS[ref.key] ?? [];
}

// Static required columns across a whole definition — the layout
// variant's `requiredFields`. {{orderNo}} is branch-dependent and is
// excluded here; layoutReadinessColumns adds the taken branch.
export function staticRequiredColumns(def: LayoutDef): Array<keyof ColumnMapping> {
  const out = new Set<keyof ColumnMapping>();
  for (const ref of tokensInDef(def)) {
    if (ref.key === "orderNo") continue;
    for (const c of columnsForToken(ref)) out.add(c);
  }
  return [...out];
}

export function defUsesOrderNo(def: LayoutDef): boolean {
  return tokensInDef(def).some((r) => r.key === "orderNo");
}

// Branch-aware readiness — static columns plus, when {{orderNo}} is
// used, the columns of the FOB/DDP branch this style actually takes
// (reuses the carton-marking ORDER_NO_RULE so builder layouts and the
// coded template can never disagree on the rule).
export function layoutReadinessColumns(
  def: LayoutDef,
  resolve: (field: keyof ColumnMapping) => string,
): Array<keyof ColumnMapping> {
  const out = staticRequiredColumns(def);
  if (defUsesOrderNo(def)) {
    for (const c of ruleRequiredColumns(ORDER_NO_RULE, resolve)) {
      if (!out.includes(c)) out.push(c);
    }
  }
  return out;
}

// Tokens in the def that resolve empty on this style — the builder's
// "missing on this style" list. Returns the printable token strings.
export function unresolvedTokens(def: LayoutDef, style: StyleData): string[] {
  const out: string[] = [];
  for (const ref of tokensInDef(def)) {
    const meta = tokenMeta(ref.key);
    if (!meta) continue;
    const value =
      meta.kind === "barcode"
        ? resolveBarcodeValue(style, (ref.arg ?? "cartonEan") as BarcodeSource)
        : resolveTextToken(style, ref.key, ref.arg);
    if (!value) out.push(`{{${ref.key}${ref.arg ? `:${ref.arg}` : ""}}}`);
  }
  return out;
}
