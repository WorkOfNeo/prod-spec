// =====================================================
// Composition line-splitting — a CLIENT-SAFE (no server imports) text
// transform applied to every {{composition:<lang>}} value by the resolver
// in tokens.ts. A garment with more than one labelled part arrives from
// Monday on ONE line:
//
//   "Outer: 91% Polyester 9% Elastane Inner: 100% Polyester"
//
// but must PRINT one part per line:
//
//   Outer: 91% Polyester 9% Elastane
//   Inner: 100% Polyester
//
// The renderer draws the newline for free: .ol-line is `white-space:
// pre-wrap` and escapeHtml leaves "\n" untouched, so a "\n" in the resolved
// value becomes a real line break in both the builder preview and the PDF.
//
// Language-agnostic by design. The part LABEL ("Outer"/"Inner") is
// translated per customer/language ("Yderstof"/"For", "Außen"/"Innen"), so
// we never match the words themselves — the invariant is a single word
// immediately followed by a colon ("<word>:"). Validated against the live
// data (see the tests): single-word labels cover every real multi-part
// composition; the multi-word phrases that occur ("Fleece Lining:", the
// German "… und Saum:") are all SINGLE-part values that correctly stay on
// one line.
// =====================================================

// A break candidate: whitespace (preceded by content) then a single-word
// label immediately before a colon. Kept SINGLE-word (no space in the
// character class) so it can never swallow a preceding value word — e.g. in
// "9% Elastane Inner:" it matches only "Inner:", never "Elastane Inner:".
// One or two spaces are tolerated before the colon ("Inside :"). Unicode
// (\p{L}) so translated labels in any script qualify.
const BREAK_RE = /(?<=\S)(\s+)([\p{L}][\p{L}.\-/&]*\s{0,2}:)/gu;

// The current line is a real, completed composition — the pre-condition for
// breaking before the NEXT label. Either it carries a percentage clause
// ("100% Cotton"), OR it already holds a "<word>: <value>" part (the
// Outer:/Inner: shape whose first value may lack a percentage, e.g.
// "Outer: Sheep Leather and Polyester"). A one-colon DESCRIPTIVE label with
// no percentage and no earlier part (the German "Kapuze, … und Saum: 50% …")
// satisfies neither, so it is left intact on one line.
const HAS_PERCENT = /\d\s*%/;
const HAS_LABELLED_VALUE = /(?:^|\s)[\p{L}][\p{L}.\-/&]*\s{0,2}:\s*\S/u;

// Split a composition string onto one line per labelled part. Returns the
// input unchanged when there is nothing to split (no colon, a single part,
// or a lone descriptive label) — so single-composition styles are never
// touched. Idempotent: an already-split value re-splits to itself.
export function formatCompositionLines(text: string): string {
  if (!text || !text.includes(":")) return text;

  let out = "";
  let cursor = 0; // next unconsumed index in `text`
  let lineStart = 0; // index where the current output line began, in `text`

  for (const m of text.matchAll(BREAK_RE)) {
    const wsStart = m.index; // start of the whitespace run before the label
    const labelStart = wsStart + m[1].length;
    const line = text.slice(lineStart, wsStart);
    // Only break once the current line is a completed composition; otherwise
    // the "<word>:" is part of a longer descriptive label, not a new part.
    if (!HAS_PERCENT.test(line) && !HAS_LABELLED_VALUE.test(line)) continue;
    out += text.slice(cursor, wsStart); // value up to (not incl.) the whitespace
    out += "\n"; // the whitespace run is dropped, replaced by the break
    cursor = labelStart;
    lineStart = labelStart;
  }
  out += text.slice(cursor);

  // Tidy: trim each line and drop a separator (comma / semicolon / period)
  // stranded at a break point ("Outer: 100% Polyester," → "Outer: 100%
  // Polyester"). Empty lines are dropped so stray whitespace can't create a
  // blank row.
  const lines = out
    .split("\n")
    .map((l) => l.trim().replace(/[,;.]+$/, "").trim())
    .filter(Boolean);
  return lines.join("\n");
}
