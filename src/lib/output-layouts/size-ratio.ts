// =====================================================
// Size Ratio — the Pre-Order board's "Size Ratio" text column (text76__1),
// parsed into the per-size assortment table a style prospect prints.
// CLIENT-SAFE (token-meta.ts and the builder palette import it, like
// schema.ts / calc.ts / carton-qty.ts) — no server deps.
//
// Buyers fill this column by hand, and a census of all 3,457 non-empty
// live values (2026-07-30) found SIX shapes. They divide into two families
// that mean DIFFERENT things:
//
//   POSITIONAL — already a ratio, printed as typed:
//     "1,1,2"            64.0%   one number per size, in the size column's
//     "4,4,3,3"                  order (the same order the EANs follow)
//     "6"                 2.3%   a single number = the same ratio for every
//                                size
//
//   LABELLED — the buyer typed TOTAL ORDER QUANTITIES per size, so the
//   ratio has to be derived from them (see reduceByGcd):
//     "S-2000, M-4000, L-5000, XL-4800"        15.8%
//     "98/104=115, 110/116=265, 122/128=295"   10.0%
//     "S/800, M/1200, L/1200"                   0.9%
//
// And one dual shape that carries both a solid-carton and an assortment
// run in a single cell:
//     "Solid - 60, 180, 270, 240, 90. Assort - 2,4,4,2,2"   7.0%
// The assortment table wants the ASSORT numbers; pickAssortSegment slices
// them out and the result re-enters the pipeline as one of the shapes above.
//
// Fallback contract, matching size-scoped-text.ts: anything we can't read
// with confidence yields NO entries rather than a guess, so the token
// renders blank (amber chip in the builder preview) instead of printing a
// wrong ratio onto a customer-facing prospect.
// =====================================================

export type SizeRatioEntry = {
  // The style's own size label, in size-column order.
  size: string;
  // The ratio for that size, "" when this size has no value. Always a
  // plain integer string — never a unit or the buyer's raw text.
  qty: string;
};

// Space-insensitive, case-insensitive size key ("4-5 ÅR" ≡ "4-5ÅR") — the
// same normalisation size-scoped-text.ts uses, so a label matches here
// exactly when it matches there.
function sizeKey(label: string): string {
  return label.replace(/\s+/g, "").toUpperCase();
}

// -----------------------------------------------------
// Solid / Assort dual values
// -----------------------------------------------------

const SOLID_RE = /\bsolid\w*\b/i;
const ASSORT_RE = /\bassort\w*\b/i;

// The ASSORT half of a dual "Solid - … Assort - …" value. Only slices when
// BOTH markers are present: a solid-only value ("Solid= S-200, M-400, …")
// is the only run there is, and its "Solid=" prefix is harmless downstream
// because it is not a size label and so never anchors.
export function pickAssortSegment(raw: string): string {
  const text = raw.trim();
  if (!SOLID_RE.test(text) || !ASSORT_RE.test(text)) return text;
  // Everything after the "Assort" marker up to a following "Solid" marker
  // (the two halves appear in either order), minus the separator that
  // introduces it and any trailing sentence period.
  const m = /\bassort\w*\b\s*[-–—:=]*\s*([\s\S]*?)(?=\bsolid\w*\b|$)/i.exec(text);
  const seg = (m?.[1] ?? "").trim().replace(/[.;]+$/, "").trim();
  return seg || text;
}

// -----------------------------------------------------
// LABELLED shapes — "<size><sep><number>", separator one of - = : /
// -----------------------------------------------------

// A separator may be any of these; "/" and "-" also occur INSIDE size
// labels ("98/104", "4-5 ÅR"), which is exactly why anchors are found by
// matching known size labels rather than by splitting on punctuation.
const SEPARATORS = "[-=:/–—]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Anchor = { key: string; end: number; valueStart: number; valueEnd: number };

// Every "<known size><sep>" site in the text. Labels are tried LONGEST
// first and claimed spans never overlap, so on a style sized "S/M, M" the
// "M" inside "S/M-4" can't steal the anchor from "S/M".
function findLabelAnchors(text: string, labels: readonly string[]): Anchor[] {
  const byLength = [...new Set(labels)].sort((a, b) => b.length - a.length);
  const anchors: Anchor[] = [];
  const claimed: Array<[number, number]> = [];

  for (const label of byLength) {
    // The label's own spaces match any (or no) whitespace, so "4-5 ÅR"
    // anchors on the buyer's "4-5ÅR". Boundaries are asserted as "not a
    // letter or digit" because \b is unreliable against "/" and non-ASCII.
    const body = escapeRe(label.replace(/\s+/g, " ")).replace(/\\?\s/g, "\\s*");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})\\s*${SEPARATORS}\\s*`, "giu");
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      anchors.push({ key: sizeKey(label), end: start, valueStart: end, valueEnd: text.length });
    }
  }

  anchors.sort((a, b) => a.valueStart - b.valueStart);
  // Each entry's value runs until the next entry begins.
  for (let i = 0; i < anchors.length - 1; i++) anchors[i].valueEnd = anchors[i + 1].end;
  return anchors;
}

// size key → the buyer's number for that size. Sizes the buyer skipped, and
// entries whose value carries no number at all ("3XL-NO RATIO"), are absent.
function parseLabelled(text: string, labels: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of findLabelAnchors(text, labels)) {
    const m = /\d+/.exec(text.slice(a.valueStart, a.valueEnd));
    if (!m) continue;
    const n = Number(m[0]);
    if (Number.isFinite(n) && n > 0 && !out.has(a.key)) out.set(a.key, n);
  }
  return out;
}

// -----------------------------------------------------
// POSITIONAL shapes — bare numbers in size order
// -----------------------------------------------------

// The WHOLE value must be numbers and separators, so a stray word can never
// be read as a ratio. A trailing period ("1,2,2,1.") is list punctuation.
function parsePositional(text: string): number[] | null {
  const t = text.trim().replace(/[.;]+$/, "").trim();
  if (!/^\d+(\s*[,\s]\s*\d+)*$/.test(t)) return null;
  return t.split(/[,\s]+/).filter(Boolean).map(Number);
}

// Last resort for a value that STARTS with a clean run of numbers and then
// trails off into prose — the live "4,6,6,4 / 3XL-NO RATIO" shape. Needs at
// least two numbers so a lone digit inside a sentence can't qualify.
function parsePositionalPrefix(text: string): number[] | null {
  const m = /^\s*(\d+(?:\s*[,\s]\s*\d+)+)/.exec(text);
  if (!m) return null;
  return m[1].split(/[,\s]+/).filter(Boolean).map(Number);
}

// A positional run introduced by a label that names the RUN rather than a
// size — a carton kind or a colourway, which buyers prepend freely:
//
//   "Solid - 800, 1000, 1200, 1000, 1000"
//   "Navy - 1, 2, 1"      "Red/White - 1, 1, 2"      "One size- 1000"
//
// Deliberately narrow, because this is the one place a WORD is allowed to
// precede the numbers: the prefix must be letters only (no digits, so a
// mis-typed size label like "134/140- 312PCS" can never qualify), and
// everything after the separator must be purely numeric — which is what
// stops "Black-1,2,2,1 & Mix Pack-1,2,2,1" and "Col 5: 22500, Col 6: 7500"
// from being read as a ratio.
const RUN_LABEL_RE = /^\s*\p{L}[\p{L}\s/&.]*\s*[-=:–—]\s*(?=\d)/u;

function stripRunLabel(text: string): string | null {
  const m = RUN_LABEL_RE.exec(text);
  return m ? text.slice(m[0].length) : null;
}

// -----------------------------------------------------
// Total order quantities → ratio
// -----------------------------------------------------

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

// Divide every quantity by their greatest common divisor — the smallest
// whole-number ratio the buyer's totals describe. Deliberately idempotent
// on values that are ALREADY a ratio: "S-1, M-2, L-2, XL-2" has a GCD of 1
// and comes back untouched, while "S-2000, M-4000, L-5000, XL-4800" reduces
// by 200 to 10:20:25:24. A run that shares no common factor
// ("S-51, M-79, L-100") simply doesn't reduce — that IS its ratio.
export function reduceByGcd(values: readonly number[]): number[] {
  const g = values.reduce((acc, n) => gcd(acc, n), 0);
  return g > 1 ? values.map((n) => n / g) : [...values];
}

// -----------------------------------------------------
// Entry point
// -----------------------------------------------------

// Pair a raw Size Ratio value against the style's size run. Entries come
// back in SIZE-COLUMN order (the order the EANs follow), one per size, so
// the table's header and quantity rows always line up. Returns [] when the
// value can't be read, or when it yields no number for any size.
export function parseSizeRatio(
  raw: string | undefined,
  sizeLabels: readonly string[],
): SizeRatioEntry[] {
  const labels = sizeLabels.map((l) => l.trim()).filter(Boolean);
  const text = (raw ?? "").trim();
  if (!text || labels.length === 0) return [];

  const segment = pickAssortSegment(text);

  // 1. Labelled — the buyer named each size, so pair by name and derive the
  //    ratio from what are total order quantities.
  const labelled = parseLabelled(segment, labels);
  if (labelled.size > 0) {
    const picked = labels.map((l) => labelled.get(sizeKey(l)));
    const reduced = reduceByGcd(picked.filter((n): n is number => n !== undefined));
    let next = 0;
    const entries = labels.map((label, i) => ({
      size: label,
      qty: picked[i] === undefined ? "" : String(reduced[next++]),
    }));
    return entries.some((e) => e.qty) ? entries : [];
  }

  // 2. Positional — already a ratio, printed as typed. A run-naming prefix
  //    ("Solid - ", "Navy - ") is stripped first; the numbers behind it are
  //    still positional, so they are NOT reduced either.
  const bare = stripRunLabel(segment);
  const nums =
    parsePositional(segment) ??
    (bare !== null ? parsePositional(bare) : null) ??
    parsePositionalPrefix(segment);
  if (!nums || nums.length === 0) return [];

  // A single number across a multi-size run is one ratio for every size.
  if (nums.length === 1 && labels.length > 1) {
    return labels.map((label) => ({ size: label, qty: String(nums[0]) }));
  }

  // Otherwise pair in order. A short run leaves the trailing sizes blank
  // (visible in the table, never invented); a long one drops the extras.
  return labels.map((label, i) => ({
    size: label,
    qty: i < nums.length ? String(nums[i]) : "",
  }));
}

// -----------------------------------------------------
// Presentation helpers
// -----------------------------------------------------

// Flat text form for {{sizeRatio}} — "S: 1, M: 2, L: 2". Sizes with no
// value are omitted so the line never carries a dangling label.
export function formatSizeRatio(entries: readonly SizeRatioEntry[]): string {
  return entries
    .filter((e) => e.qty)
    .map((e) => `${e.size}: ${e.qty}`)
    .join(", ");
}

// The unit printed beside the assortment total. One constant so the table
// cell and the text stand-in can never drift apart.
export const ASSORT_TOTAL_UNIT = "PCS";

// The pack's total: every number the table PRINTS, added up — "1,2,2,1" → 6.
// Sizes the buyer gave no value contribute nothing (they show as an empty
// cell, so they must not inflate the total), which means the total always
// equals the qty row a reader can add up by hand.
export function sumSizeRatio(entries: readonly SizeRatioEntry[]): number {
  return entries.reduce((sum, e) => {
    const n = Number(e.qty);
    return e.qty && Number.isFinite(n) ? sum + n : sum;
  }, 0);
}

// The total as it prints — "12 PCS". "" when the run totals nothing, so an
// unreadable ratio drops the cell rather than printing a misleading 0.
export function formatSizeRatioTotal(entries: readonly SizeRatioEntry[]): string {
  const total = sumSizeRatio(entries);
  return total > 0 ? `${total} ${ASSORT_TOTAL_UNIT}` : "";
}

// The ratio for the size(s) a repetition row was narrowed to — backs
// {{sizeRatio:size}}. Several matches (a carton grouping sizes) join with
// ", ", mirroring narrowSizeScopedText.
export function pickSizeRatioForSizes(
  entries: readonly SizeRatioEntry[],
  rowSizeLabels: readonly string[],
): string {
  const wanted = new Set(rowSizeLabels.map(sizeKey).filter(Boolean));
  if (wanted.size === 0) return "";
  return entries
    .filter((e) => wanted.has(sizeKey(e.size)) && e.qty)
    .map((e) => e.qty)
    .join(", ");
}
