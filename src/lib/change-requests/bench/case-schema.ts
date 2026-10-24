// =====================================================
// Change-request bench — what a case is.
//
// A case is one real-shaped change request, frozen with everything the agent
// would look up while working on it, so it can be replayed against the real
// model with no database: the request as written, the layout it is about,
// a handful of styles (StyleData overrides on top of buildSampleStyleData),
// and what a right answer looks like. scripts/cr-bench.ts loads the case
// files under scripts/cr-bench/cases/; fixture-tools.ts serves them to the
// agent; score.ts grades the result.
//
// The repo is public: cases are synthetic. Strip customer names, PO numbers,
// EANs and file names from a real request before it becomes a case (see
// scripts/cr-bench/README.md).
//
// Style `values` are StyleData overrides, NOT token values: a case sets the
// raw field the way Monday would fill it (`trimsRaw: "Solid polybag- 5 Pcs /
// Polybag"`) and the production resolvers derive the token from it
// ({{polybagQty}} → "5"), so a case can't hand the agent a value the real
// pipeline would never produce. Keys (see applyStyleOverrides):
//   • a top-level text field of StyleData — styleNumber, productGroup,
//     trimsRaw, description, customerItemNo, … (STYLE_TEXT_FIELDS);
//   • a dotted path into colour / carton / price — colour.name,
//     carton.klNumber, price.currency, …;
//   • price — "24,95" or "24.95" ("" removes the price);
//   • composition:<lang>, productName:<lang>, careInstructions:<lang> —
//     that language's text ("" removes it);
//   • washSymbols, certificates, outputLanguages — comma-separated lists
//     ("" = none; the first output language is the one list_tokens resolves
//     per-language variables in, next to "en", as in production);
//   • sizes — comma-separated labels, each optionally "LABEL=EAN13".
// Anything else is rejected when the case loads, so a typo can't silently
// leave a fixture on the sample value.
//
// PURE (zod + the layout schema + sample data): no database, no network.
// =====================================================

import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import type { StyleData } from "@/lib/pdf/types";
import { LayoutDefSchema, pageGrid, parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import { LAYOUT_TOKENS } from "@/lib/output-layouts/token-meta";

// ── Style overrides ──────────────────────────────────────────────────────────

export const STYLE_TEXT_FIELDS = [
  "styleName",
  "styleNumber",
  "customerName",
  "businessArea",
  "compositionColour",
  "cartonQtyRaw",
  "sizeRatioRaw",
  "unitOfMeasure",
  "customerItemNoRaw",
  "styleCommentsRaw",
  "trimsRaw",
  "productGroup",
  "supplierEmail",
  "poNumber",
  "customerOrderNo",
  "deliveryTerm",
  "countryOfOrigin",
  "customerItemNo",
  "campaignWeek",
  "batchNo",
  "prodNumber",
  "description",
] as const;

const NESTED_TEXT_FIELDS = {
  colour: ["name", "code"],
  carton: ["klNumber", "supplierNumber", "lot", "ean13", "assortEan"],
} as const;

const LANG_FIELDS = ["composition", "productName", "careInstructions"] as const;
const LIST_FIELDS = ["washSymbols", "certificates", "outputLanguages"] as const;
const PRICE_CURRENCIES = ["EUR", "DKK", "NOK", "SEK", "GBP"] as const;
const LANG_RE = /^[a-z]{2}$/;
const EAN13_RE = /^\d{13}$/;

// null when the key is a supported override, else why not.
export function overrideKeyError(key: string): string | null {
  if ((STYLE_TEXT_FIELDS as readonly string[]).includes(key)) return null;
  if (key === "price" || key === "price.currency" || key === "sizes" || key === "carton.outerVE") return null;
  if ((LIST_FIELDS as readonly string[]).includes(key)) return null;
  const dot = key.split(".");
  if (dot.length === 2 && dot[0] in NESTED_TEXT_FIELDS) {
    const fields = NESTED_TEXT_FIELDS[dot[0] as keyof typeof NESTED_TEXT_FIELDS] as readonly string[];
    if (fields.includes(dot[1])) return null;
  }
  const colon = key.split(":");
  if (colon.length === 2 && (LANG_FIELDS as readonly string[]).includes(colon[0])) {
    return LANG_RE.test(colon[1]) ? null : `"${key}": the language must be a two-letter code, e.g. ${colon[0]}:fi`;
  }
  return (
    `"${key}" is not a style override — use a StyleData text field (${STYLE_TEXT_FIELDS.join(", ")}), ` +
    `colour.name/code, carton.<field>, price, price.currency, composition:<lang>, productName:<lang>, ` +
    `careInstructions:<lang>, washSymbols, certificates, outputLanguages or sizes`
  );
}

// null when the value is acceptable for the key.
function overrideValueError(key: string, value: string): string | null {
  if (key === "price" && value.trim() !== "" && !Number.isFinite(parsePrice(value))) {
    return `"price" must be a number like 24,95 (got ${JSON.stringify(value)})`;
  }
  if (key === "price.currency" && value !== "" && !(PRICE_CURRENCIES as readonly string[]).includes(value)) {
    return `"price.currency" must be one of ${PRICE_CURRENCIES.join(", ")} or ""`;
  }
  if (key === "carton.outerVE" && !Number.isInteger(Number(value))) return `"carton.outerVE" must be a whole number`;
  if (key === "sizes") {
    for (const item of splitList(value)) {
      const [label, ean] = item.split("=").map((s) => s.trim());
      if (!label) return `"sizes": empty size label in ${JSON.stringify(value)}`;
      if (ean !== undefined && !EAN13_RE.test(ean)) return `"sizes": "${item}" — the EAN after "=" must be 13 digits`;
    }
  }
  return null;
}

function parsePrice(value: string): number {
  return Number(value.trim().replace(",", "."));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function setLang(list: StyleData["composition"], lang: string, text: string): StyleData["composition"] {
  const rest = list.filter((c) => c.language.toLowerCase() !== lang);
  return text === "" ? rest : [...rest, { language: lang, text }];
}

// The fixture StyleData: overrides applied in key order on a fresh copy of the
// sample. Throws on an unsupported key (the schema catches those first).
export function applyStyleOverrides(base: StyleData, values: Readonly<Record<string, string>>): StyleData {
  const s: StyleData = structuredClone(base);
  const loose = s as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    const err = overrideKeyError(key) ?? overrideValueError(key, value);
    if (err) throw new Error(err);
    if ((STYLE_TEXT_FIELDS as readonly string[]).includes(key)) {
      loose[key] = value;
    } else if (key === "price") {
      if (value.trim() === "") delete s.price;
      else s.price = { ...(s.price ?? {}), amount: parsePrice(value) };
    } else if (key === "price.currency") {
      if (!s.price) s.price = { amount: 0 };
      if (value === "") delete s.price.currency;
      else s.price.currency = value as (typeof PRICE_CURRENCIES)[number];
    } else if (key === "carton.outerVE") {
      s.carton.outerVE = Number(value);
    } else if (key === "sizes") {
      s.sizes = splitList(value).map((item) => {
        const [label, ean] = item.split("=").map((x) => x.trim());
        return { label, ean13: ean ?? "" };
      });
      // A per-size carton list built for the sample's sizes would contradict
      // the case's own run; the case sets cartons explicitly if it needs them.
      delete s.carton.perSize;
      delete s.eanVariants;
      delete s.allSizes;
    } else if (key === "washSymbols") {
      s.washSymbols = splitList(value);
    } else if (key === "certificates") {
      s.certificates = splitList(value);
    } else if (key === "outputLanguages") {
      s.outputLanguages = splitList(value);
    } else if (key.includes(".")) {
      const [obj, field] = key.split(".") as ["colour" | "carton", string];
      if (obj === "colour") s.colour = { ...(s.colour ?? { name: "", code: "" }), [field]: value };
      else (s.carton as unknown as Record<string, unknown>)[field] = value;
    } else {
      const [field, lang] = key.split(":") as [(typeof LANG_FIELDS)[number], string];
      if (field === "composition") s.composition = setLang(s.composition, lang, value);
      else if (field === "productName") s.productNameTranslations = setLang(s.productNameTranslations, lang, value);
      else {
        const map = { ...(s.careInstructionsByLang ?? {}) };
        if (value === "") delete map[lang];
        else map[lang] = value;
        s.careInstructionsByLang = map;
      }
    }
  }
  return s;
}

// ── The case ─────────────────────────────────────────────────────────────────

const RectSchema = z.object({
  col: z.number().int().min(0),
  row: z.number().int().min(0),
  colSpan: z.number().int().min(1),
  rowSpan: z.number().int().min(1),
});

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const BenchStyleSchema = z.object({
  id: z.string().regex(ID_RE, "lowercase letters, digits and hyphens"),
  label: z.string().min(1),
  // "changed": a style the request is about (its documents should change).
  // "control": a style the change must leave alone. The first "changed"
  // style (or the first style) is the request's representative style.
  group: z.enum(["changed", "control"]).optional(),
  values: z.record(z.string(), z.string()).default({}),
});

// A layout definition as stored, run through parseLayoutDef so every block
// has the stable id the agent addresses it by.
const DefinitionSchema = z.unknown().transform((raw, ctx): LayoutDef => {
  if (!raw || typeof raw !== "object" || !("pages" in raw)) {
    ctx.addIssue({ code: "custom", message: "definition must be a layout definition with pages" });
    return z.NEVER;
  }
  const parsed = LayoutDefSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return parseLayoutDef(raw);
});

export const BenchCaseSchema = z
  .object({
    id: z.string().regex(ID_RE, "lowercase letters, digits and hyphens"),
    title: z.string().min(1),
    request: z.object({
      // The request as written (the whole message).
      message: z.string().min(1),
      // The output this case is about ("Solid polybag sticker").
      outputLabel: z.string().min(1),
      // The issue text for that output.
      text: z.string().min(1),
    }),
    // Screenshots, relative to the case file.
    images: z.array(z.string().min(1)).optional(),
    layout: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      docType: z.string().min(1),
      definition: DefinitionSchema,
    }),
    // Tokens hidden from the agent, as if they did not exist yet: missing
    // from list_tokens, refused in propose_patch, accepted by declare_gap.
    removeTokens: z.array(z.string()).optional(),
    styles: z.array(BenchStyleSchema).min(1),
    expected: z.object({
      verdict: z.enum(["patch", "gap", "question"]),
      // Each entry is a token key, or alternatives separated by "|"
      // ("composition|compositionLines"): one of them must be used.
      tokensUsed: z.array(z.string().min(1)).optional(),
      block: z
        .object({
          page: z.number().int().min(0),
          rect: RectSchema,
          // Max |Δcol|+|Δrow|+|ΔcolSpan|+|ΔrowSpan| that still counts as placed.
          tolerance: z.number().int().min(0),
          // Substrings the block's lines must contain (all of them).
          lineIncludes: z.array(z.string()).optional(),
        })
        .optional(),
      gapTokenKey: z.string().optional(),
      mustNotChangeStyleIds: z.array(z.string()).optional(),
    }),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.styles.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["styles", i, "id"], message: `duplicate style id "${s.id}"` });
      ids.add(s.id);
      for (const [key, value] of Object.entries(s.values)) {
        const err = overrideKeyError(key) ?? overrideValueError(key, value);
        if (err) ctx.addIssue({ code: "custom", path: ["styles", i, "values", key], message: err });
      }
    });
    (c.expected.mustNotChangeStyleIds ?? []).forEach((id, i) => {
      if (!ids.has(id)) {
        ctx.addIssue({ code: "custom", path: ["expected", "mustNotChangeStyleIds", i], message: `no style "${id}" in this case` });
      }
    });
    const known = new Set(LAYOUT_TOKENS.map((t) => t.key));
    (c.removeTokens ?? []).forEach((key, i) => {
      if (!known.has(key)) ctx.addIssue({ code: "custom", path: ["removeTokens", i], message: `unknown token "${key}"` });
    });
    if (c.expected.verdict === "gap" && !c.expected.gapTokenKey) {
      ctx.addIssue({ code: "custom", path: ["expected", "gapTokenKey"], message: "a gap case needs gapTokenKey" });
    }
    const b = c.expected.block;
    if (b) {
      const page = c.layout.definition.pages[b.page];
      if (!page) {
        ctx.addIssue({ code: "custom", path: ["expected", "block", "page"], message: `the layout has no page ${b.page}` });
      } else {
        const { cols, rows } = pageGrid(page);
        if (b.rect.col + b.rect.colSpan > cols || b.rect.row + b.rect.rowSpan > rows) {
          ctx.addIssue({ code: "custom", path: ["expected", "block", "rect"], message: `rect runs past the ${cols}×${rows} grid` });
        }
      }
    }
    (c.images ?? []).forEach((p, i) => {
      if (isAbsolute(p)) ctx.addIssue({ code: "custom", path: ["images", i], message: "image paths are relative to the case file" });
    });
  });

export type BenchCase = z.infer<typeof BenchCaseSchema>;
export type BenchStyle = BenchCase["styles"][number];
export type BenchVerdict = BenchCase["expected"]["verdict"];

// The style the request is about: the first "changed" style, else the first.
export function representativeStyle(c: BenchCase): BenchStyle {
  return c.styles.find((s) => s.group === "changed") ?? c.styles[0];
}

// A style's fixture StyleData (sample data + the case's overrides).
export function benchStyleData(c: BenchCase, styleId: string): StyleData {
  const style = c.styles.find((s) => s.id === styleId);
  if (!style) throw new Error(`no style "${styleId}" in case ${c.id}`);
  return applyStyleOverrides(buildSampleStyleData(), style.values);
}

// ── Loading ──────────────────────────────────────────────────────────────────

export type LoadedBenchCase = {
  case: BenchCase;
  file: string;
  // Absolute paths of the case's screenshots.
  imagePaths: string[];
};

export function parseBenchCase(raw: unknown, file = "<case>"): BenchCase {
  const parsed = BenchCaseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `  ${i.path.map(String).join(".") || "(case)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid bench case ${file}:\n${issues}`);
  }
  return parsed.data;
}

export function loadBenchCase(file: string): LoadedBenchCase {
  const abs = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Could not read bench case ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const c = parseBenchCase(raw, abs);
  return { case: c, file: abs, imagePaths: (c.images ?? []).map((p) => resolve(dirname(abs), p)) };
}

// Every *.json in a directory, sorted by file name. Case ids must be unique.
export function loadBenchCases(dir: string): LoadedBenchCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const loaded = files.map((f) => loadBenchCase(join(dir, f)));
  const seen = new Map<string, string>();
  for (const l of loaded) {
    const prev = seen.get(l.case.id);
    if (prev) throw new Error(`Bench case id "${l.case.id}" is used by both ${prev} and ${l.file}`);
    seen.set(l.case.id, l.file);
  }
  return loaded;
}
