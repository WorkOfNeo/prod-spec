import type { StyleData } from "@/lib/pdf/types";
import type { LayoutSettings } from "./schema";

// DB-free leaf module for the file-name collision RULES — which token
// separates a set of repetition rows, and how to phrase that as a fix. Split
// out of filename-collisions.ts (which pulls in Prisma) on the same principle
// as supplier-digest.ts: the rules are the part worth unit-testing, and a test
// should not need a DATABASE_URL to import them.

// Tokens we offer as disambiguators, cheapest/most-readable first. Order
// matters — suggestFix walks it and returns the FIRST prefix that separates
// every row, so a layout that only needs {{size}} is never told to add the
// EAN. {{ean13}} is last because a filename carrying a 13-digit barcode is
// the least pleasant to read, and it is the only one guaranteed to be unique.
const CANDIDATE_TOKENS = ["size", "colourName", "compositionColour", "ean13"] as const;
export type CandidateToken = (typeof CANDIDATE_TOKENS)[number];

const TOKEN_LABEL: Record<CandidateToken, string> = {
  size: "{{size}}",
  colourName: "{{colourName}}",
  compositionColour: "{{compositionColour}}",
  ean13: "{{ean13}}",
};

// The identifying values of one repetition row, as the filename expression
// would see them. Kept as plain strings (not the StyleData) so the analysis
// is serialisable straight into a server-component payload.
export type RepetitionRow = {
  // The runner's stable per-document discriminator, mirrored from
  // splitFilePlan — also the JobAsset variantKey suffix ("...#S-bl").
  suffix: string;
  size: string;
  colourName: string;
  // The colour of this row's composition, on a per-composition split — the
  // only token that separates two rows of the same size and EAN.
  compositionColour: string;
  ean13: string;
  cartonEan: string;
  // What the layout's CURRENT fileName expression resolves to for this row.
  // null when the layout has no custom expression (runner default applies,
  // which already appends the suffix and therefore cannot collide).
  fileName: string | null;
};

export type CollisionGroup = {
  fileName: string;
  rows: RepetitionRow[];
  // Which of the candidate tokens actually differ across these rows. A token
  // absent here is identical on every row and so cannot separate them —
  // this is the "what makes them indistinguishable" answer.
  varyingTokens: CandidateToken[];
  // Minimal token set that would make every row unique, or null when no
  // combination does (identical size, colour AND EAN — a data problem, not a
  // template problem).
  suggestion: CandidateToken[] | null;
};

export type StyleAnalysis = {
  styleId: string;
  styleName: string;
  poNumber: string | null;
  expression: string;
  rows: RepetitionRow[];
  collisions: CollisionGroup[];
};

function tokenValue(row: RepetitionRow, token: CandidateToken): string {
  return token === "size"
    ? row.size
    : token === "colourName"
      ? row.colourName
      : token === "compositionColour"
        ? row.compositionColour
        : row.ean13;
}

// The minimal prefix of CANDIDATE_TOKENS that makes every row distinct.
// Prefixes rather than arbitrary subsets: a filename reading
// "…-{{colourName}}-{{ean13}}" without the size would be actively confusing
// to a supplier reading it off a carton, so we only ever ADD specificity in
// the natural size → colour → EAN order.
export function suggestFix(rows: RepetitionRow[]): CandidateToken[] | null {
  // A token that is EMPTY on every row can only add an empty segment to the
  // name, so it never earns its place in the suggestion — this is what keeps
  // {{compositionColour}} out of the advice for the layouts (the vast
  // majority) that don't split per composition.
  const candidates = CANDIDATE_TOKENS.filter((t) => rows.some((r) => tokenValue(r, t).trim()));
  for (let n = 1; n <= candidates.length; n += 1) {
    const prefix = candidates.slice(0, n);
    // JSON-encoded rather than string-joined: a plain separator would let
    // ["A B","C"] and ["A","B C"] alias into one key and under-report a collision.
    const keys = rows.map((r) => JSON.stringify(prefix.map((t) => tokenValue(r, t))));
    if (new Set(keys).size === rows.length) return [...prefix];
  }
  return null;
}

// Phrase the fix against what the expression ALREADY contains. Most of these
// templates already carry {{size}} and {{colourName}} and still collide — being
// told to "add {{size}}" when it is right there reads as a bug in the report
// and buries the one token that actually matters.
export function describeSuggestion(
  suggestion: CandidateToken[] | null,
  expression = "",
): string {
  if (!suggestion) {
    return "No token can separate these — the rows are identical in size, colour and EAN. This is a PO/EAN data problem, not a template one.";
  }
  const missing = suggestion.filter((t) => !new RegExp(`\\{\\{\\s*${t}\\s*\\}\\}`).test(expression));
  if (missing.length === 0) {
    // Every needed token is present yet the rows still collide — the values
    // themselves are duplicated upstream.
    return "The needed tokens are already in the name, but the rows resolve to the same values — check the style's EAN rows.";
  }
  return `Add ${missing.map((t) => TOKEN_LABEL[t]).join(" + ")} to the file name.`;
}

// Which candidate tokens actually take more than one distinct value here.
export function varyingTokens(rows: RepetitionRow[]): CandidateToken[] {
  return CANDIDATE_TOKENS.filter((t) => new Set(rows.map((r) => tokenValue(r, t))).size > 1);
}

// Mirror of splitFilePlan's suffix rule (variants.ts). Duplicated rather than
// exported-and-shared because splitFilePlan also renders; if that rule ever
// changes, the collision report must follow it — the shared test in
// filename-collisions.test.ts pins the two together.
export function suffixFor(repStyle: StyleData, repeatBy: LayoutSettings["repeatBy"], i: number, seen: Map<string, number>): string {
  const sizePart = (repStyle.sizes[0]?.label ?? "").replace(/[^\w.-]+/g, "");
  const colourPart =
    repeatBy === "ean" || repeatBy === "cartonEan" || repeatBy === "cartonEanSizeOnly"
      ? (repStyle.colour?.name ?? "").replace(/[^\w.-]+/g, "").slice(0, 16)
      : "";
  const compositionPart = (repStyle.compositionColour ?? "").replace(/[^\w.-]+/g, "").slice(0, 16);
  let suffix =
    repeatBy === "assort" || repStyle.isAssortment
      ? ["assort", compositionPart].filter(Boolean).join("-")
      : [sizePart, colourPart, compositionPart].filter(Boolean).join("-").slice(0, 40) || String(i + 1);
  const n = (seen.get(suffix) ?? 0) + 1;
  seen.set(suffix, n);
  if (n > 1) suffix = `${suffix}-${n}`;
  return suffix;
}

