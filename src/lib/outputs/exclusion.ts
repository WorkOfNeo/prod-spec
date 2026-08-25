// =====================================================
// Output generation rules — "generate this output only when a style matches",
// or "never generate it when it matches". A rule matches a SYNCED style field
// (a ColumnMapping key, e.g. productGroup) against a list of keywords.
//
// Two scopes carry rules, evaluated with the same engine:
//   • DOC TYPE (DocTypeDef.exclusionRules, Output Builder → Document types) —
//     applies to EVERY output of that type. "Socks skip wash care."
//   • OUTPUT (LayoutSettings.rules, Output Builder → the layout's Settings
//     tab) — applies to that one layout. "This barcode sticker exists only
//     for shoes."
// Both gates must pass: the output's own rules are checked first (a hit names
// the output), then its type's.
//
// Two directions per rule:
//   • "exclude" (default) — a match SKIPS the output. Any exclude rule that
//     matches vetoes, whatever the include rules say.
//   • "include" — the output generates ONLY when at least one include rule
//     matches. Several include rules are alternatives (any one is enough); a
//     field that resolves to nothing matches neither, so an include-only
//     output stays un-generated until the field is synced.
// Either way the style/review surfaces WHY, so a missing document never reads
// as a silent failure.
//
// This module is CLIENT-SAFE (no db / no server imports): the rule editors
// render from EXCLUSION_FIELDS, and both the runner and the review/readiness
// chain match through matchOutputRulesFor with a server-built field resolver.
// Keep it pure so it can be unit-tested and imported from client components
// alike.
// =====================================================

import { STYLE_FIELD_LABELS } from "@/lib/styles/resolved-fields";

export type RuleOp = "contains" | "equals";

// "exclude" — don't generate when this matches (the original behaviour, and
// the default for rules stored before modes existed).
// "include" — generate ONLY when this matches.
export type RuleMode = "exclude" | "include";

export type OutputRule = {
  // A synced field — a ColumnMapping key (e.g. "productGroup"). Matching reads
  // it through the same resolver readiness/render use, so a rule can target
  // anything we sync from the board.
  field: string;
  op: RuleOp;
  // Any keyword matching → the rule matches. Case-insensitive, trimmed. A list
  // (not one word) because real taxonomies are messy: "shoes" alone misses
  // boots/sandals/clogs/sneakers/slippers.
  keywords: string[];
  // Absent = "exclude" — every rule written before this field existed is a
  // don't-generate rule, and stays one.
  mode?: RuleMode;
};

export function ruleMode(rule: OutputRule): RuleMode {
  return rule.mode === "include" ? "include" : "exclude";
}

// docType value → its rules. The runner / readiness chain look a doc type up
// here; an absent or empty entry means "no type-level rule". Per-OUTPUT rules
// don't live in this map — they ride on the TemplateVariant
// (`generationRules`), so every caller of the readiness engine gets them
// without having to load and thread a second map.
export type DocTypeRulesMap = Record<string, OutputRule[]>;

// The synced fields offered in the rule editors. A curated subset of the
// ColumnMapping keys (the ones worth gating on), labelled from the shared
// STYLE_FIELD_LABELS so the names match the Details tab. productGroup is the
// primary one (carries Socks / Shoes / Boots / …).
//
// The ORDER-NUMBER fields gate on how a PO is packed rather than on what the
// product is. A PO shipping BOTH packings carries both numbers in one cell —
// "Assort - 4530763 / Solid - 4530769" — so a pair of care labels can split
// on it: one "only when customer order no contains solid", one "…assort",
// each printing its own {{customerOrderNo:solid|:assort}} and file name.
// Give the ORIGINAL label an "exclude when … contains assort" rule at the
// same time: a single-packing PO carries a bare number that matches NEITHER
// include rule, so without that the split PO prints three labels per size
// and a normal PO still prints one.
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
  "customerOrderNo",
  "poNumber",
].map((field) => ({
  field,
  label: (STYLE_FIELD_LABELS as Record<string, string>)[field] ?? field,
}));

const FIELD_LABELS = new Map(EXCLUSION_FIELDS.map((f) => [f.field, f.label]));

export function exclusionFieldLabel(field: string): string {
  return FIELD_LABELS.get(field) ?? (STYLE_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

// Why an output won't be generated — carried to the UI so the reviewer sees
// the field, the keywords and which rule decided.
export type ExclusionHit = {
  field: string;
  op: RuleOp;
  mode: RuleMode;
  // "exclude": the one keyword that matched. "include": every keyword the rule
  // required — none of which the style matched.
  keywords: string[];
};

// Which scope decided — the output's own rule, or its document type's. Only
// the reason text differs (it names the output vs the type).
export type RuleScope = "output" | "docType";

function usableRules(rules: OutputRule[] | undefined): OutputRule[] {
  return (rules ?? []).filter(
    (r) =>
      r &&
      typeof r.field === "string" &&
      r.field.trim() !== "" &&
      Array.isArray(r.keywords) &&
      r.keywords.some((k) => (k ?? "").trim() !== ""),
  );
}

// The first keyword of `rule` the style matches, or null. Case-insensitive and
// trimmed on both sides; an empty field value matches nothing (so it can never
// satisfy an include rule either).
function matchingKeyword(rule: OutputRule, resolveField: (field: string) => string): string | null {
  const value = (resolveField(rule.field) ?? "").trim().toLowerCase();
  if (!value) return null;
  for (const raw of rule.keywords) {
    const kw = (raw ?? "").trim().toLowerCase();
    if (!kw) continue;
    const hit = rule.op === "equals" ? value === kw : value.includes(kw);
    if (hit) return (raw ?? "").trim();
  }
  return null;
}

// Evaluate ONE scope's rules for a style: the reason this output is skipped,
// or null to generate it. `resolveField` returns the style's raw value for a
// synced field (server-built; the runner and the readiness chain pass the SAME
// resolver so they can never disagree).
export function matchOutputRules(
  rules: OutputRule[] | undefined,
  resolveField: (field: string) => string,
): ExclusionHit | null {
  const usable = usableRules(rules);
  if (usable.length === 0) return null;

  // A "never generate when…" rule vetoes outright — it's the strongest thing
  // an operator can say, so it's checked before the include gate and its
  // keyword is the reason shown.
  for (const rule of usable) {
    if (ruleMode(rule) !== "exclude") continue;
    const kw = matchingKeyword(rule, resolveField);
    if (kw) return { field: rule.field, op: rule.op, mode: "exclude", keywords: [kw] };
  }

  // The include gate: with no "generate when…" rule this scope is open, with
  // one or more the style must match at least ONE of them.
  const includes = usable.filter((r) => ruleMode(r) === "include");
  if (includes.length === 0) return null;
  for (const rule of includes) {
    if (matchingKeyword(rule, resolveField)) return null;
  }
  // None matched — report the first include rule's requirement, which is what
  // the style would have to look like to get this output.
  const first = includes[0];
  return {
    field: first.field,
    op: first.op,
    mode: "include",
    keywords: first.keywords.map((k) => (k ?? "").trim()).filter(Boolean),
  };
}

// Both scopes for one output: its OWN rules (TemplateVariant.generationRules —
// Output Builder layouts only) first, then its document type's. The one place
// the two gates are combined, so the runner, the readiness gate and every
// review surface agree on what is skipped and why.
export function matchOutputRulesFor(
  outputRules: OutputRule[] | undefined,
  docTypeRules: OutputRule[] | undefined,
  resolveField: (field: string) => string,
): { hit: ExclusionHit; scope: RuleScope } | null {
  const own = matchOutputRules(outputRules, resolveField);
  if (own) return { hit: own, scope: "output" };
  const byType = matchOutputRules(docTypeRules, resolveField);
  return byType ? { hit: byType, scope: "docType" } : null;
}

// “shoes” · “shoes” or “boot” · “shoes”, “boot” or “sandal”
function quoteList(keywords: string[]): string {
  const parts = keywords.filter(Boolean).map((k) => `“${k}”`);
  if (parts.length <= 1) return parts[0] ?? "“”";
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

// Human reason for the review/style surfaces, naming the rule that decided.
// `sourceLabel` is the OUTPUT's name for an output-scope rule, the document
// type's label for a type-scope one:
//   "Not generated — Product group contains “shoes” (Wash care rule)"
//   "Not generated — Product group doesn’t contain “shoes” (Barcode sticker rule)"
export function exclusionReasonText(hit: ExclusionHit, sourceLabel: string): string {
  const field = exclusionFieldLabel(hit.field);
  const verb =
    hit.mode === "include"
      ? hit.op === "equals"
        ? "isn’t"
        : "doesn’t contain"
      : hit.op === "equals"
        ? "is"
        : "contains";
  return `Not generated — ${field} ${verb} ${quoteList(hit.keywords)} (${sourceLabel} rule)`;
}

// Plain-English echo of a single rule, for the editors — the operator reads
// back exactly what they built before it decides anything:
//   "Only when Product group contains “shoes”"
//   "Never when Product group is “Socks”"
export function ruleSentence(rule: OutputRule): string {
  const field = exclusionFieldLabel(rule.field);
  const verb = rule.op === "equals" ? "is" : "contains";
  const keywords = rule.keywords.map((k) => (k ?? "").trim()).filter(Boolean);
  const lead = ruleMode(rule) === "include" ? "Only when" : "Never when";
  return `${lead} ${field} ${verb} ${quoteList(keywords)}`;
}

// Defensive parse of the stored JSON (both DocTypeDef.exclusionRules and the
// layout definition's settings.rules are untyped Json). Drops malformed
// entries / blank keywords rather than throwing, so a hand-edited row can
// never break generation or the review page.
export function parseOutputRules(raw: unknown): OutputRule[] {
  if (!Array.isArray(raw)) return [];
  const out: OutputRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const field = typeof rec.field === "string" ? rec.field.trim() : "";
    const op: RuleOp = rec.op === "equals" ? "equals" : "contains";
    const mode: RuleMode = rec.mode === "include" ? "include" : "exclude";
    const keywords = Array.isArray(rec.keywords)
      ? rec.keywords
          .map((k) => (typeof k === "string" ? k.trim() : ""))
          .filter((k): k is string => k.length > 0)
      : [];
    if (!field || keywords.length === 0) continue;
    out.push({ field, op, keywords, mode });
  }
  return out;
}
