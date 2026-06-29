// =====================================================
// Output exclusion rules — "don't generate outputs of this document type for
// styles that match a keyword". A rule lives on a DocTypeDef (the catalogue
// row) and matches a SYNCED style field (a ColumnMapping key) against a list
// of keywords. When any rule on a doc type matches a style, EVERY output of
// that type is skipped for that style — and the review surfaces WHY.
//
// This module is CLIENT-SAFE (no db / no server imports): the doc-types
// manager renders the editor from EXCLUSION_FIELDS, and both the runner and
// the review/readiness chain match through matchExclusionRules with a
// server-built field resolver. Keep it pure so it can be unit-tested and
// imported from client components alike.
// =====================================================

import { STYLE_FIELD_LABELS } from "@/lib/styles/resolved-fields";

export type ExclusionOp = "contains" | "equals";

export type ExclusionRule = {
  // A synced field — a ColumnMapping key (e.g. "productGroup"). Matching reads
  // it through the same resolver readiness/render use, so a rule can target
  // anything we sync from the board.
  field: string;
  op: ExclusionOp;
  // Any keyword matching → the rule fires. Case-insensitive, trimmed. A list
  // (not one word) because real taxonomies are messy: "shoes" alone misses
  // boots/sandals/clogs/sneakers/slippers.
  keywords: string[];
};

// docType value → its rules. The runner / readiness chain look a doc type up
// here; an absent or empty entry means "never excluded".
export type DocTypeRulesMap = Record<string, ExclusionRule[]>;

// The synced fields offered in the rule editor. A curated subset of the
// ColumnMapping keys (the ones worth excluding on), labelled from the shared
// STYLE_FIELD_LABELS so the names match the Details tab. productGroup is the
// primary one (carries Socks / Shoes / Boots / …).
export const EXCLUSION_FIELDS: ReadonlyArray<{ field: string; label: string }> = [
  "productGroup",
  "targetGroup",
  "businessArea",
  "composition",
  "colourName",
  "campaignWeek",
  "customerItemNo",
  "description",
  "trims",
].map((field) => ({
  field,
  label: (STYLE_FIELD_LABELS as Record<string, string>)[field] ?? field,
}));

const FIELD_LABELS = new Map(EXCLUSION_FIELDS.map((f) => [f.field, f.label]));

export function exclusionFieldLabel(field: string): string {
  return FIELD_LABELS.get(field) ?? (STYLE_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

// Why an output was excluded — carried to the UI so the reviewer sees the
// field, the matched keyword, and the rule's doc type.
export type ExclusionHit = { field: string; op: ExclusionOp; keyword: string };

// First rule on `rules` that fires for the style, or null. `resolveField`
// returns the style's raw value for a synced field (server-built; the runner
// and the readiness chain pass the SAME resolver so they can never disagree).
export function matchExclusionRules(
  rules: ExclusionRule[] | undefined,
  resolveField: (field: string) => string,
): ExclusionHit | null {
  if (!rules?.length) return null;
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.keywords) || rule.keywords.length === 0) continue;
    const value = (resolveField(rule.field) ?? "").trim().toLowerCase();
    if (!value) continue;
    for (const raw of rule.keywords) {
      const kw = (raw ?? "").trim().toLowerCase();
      if (!kw) continue;
      const hit = rule.op === "equals" ? value === kw : value.includes(kw);
      if (hit) return { field: rule.field, op: rule.op, keyword: raw.trim() };
    }
  }
  return null;
}

// Human reason for the review/style surfaces, naming the rule that fired.
//   "Not generated — Product group contains “shoes” (Wash care rule)"
export function exclusionReasonText(hit: ExclusionHit, docTypeLabel: string): string {
  const verb = hit.op === "equals" ? "is" : "contains";
  return `Not generated — ${exclusionFieldLabel(hit.field)} ${verb} “${hit.keyword}” (${docTypeLabel} rule)`;
}

// Defensive parse of the stored JSON (DocTypeDef.exclusionRules is untyped
// Json). Drops malformed entries / blank keywords rather than throwing, so a
// hand-edited row can never break generation or the review page.
export function parseExclusionRules(raw: unknown): ExclusionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ExclusionRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const field = typeof rec.field === "string" ? rec.field.trim() : "";
    const op: ExclusionOp = rec.op === "equals" ? "equals" : "contains";
    const keywords = Array.isArray(rec.keywords)
      ? rec.keywords
          .map((k) => (typeof k === "string" ? k.trim() : ""))
          .filter((k): k is string => k.length > 0)
      : [];
    if (!field || keywords.length === 0) continue;
    out.push({ field, op, keywords });
  }
  return out;
}
