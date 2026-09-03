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

// A break candidate, in two flavours — the label shape depends on what
// precedes it, because that is what bounds it:
//
//   after a SEPARATOR (", " / "; " / " / ") the label may run several words:
//   the separator is the left edge, so "…Elastane, Grey melange:" can only
//   read "Grey melange" as the label. The separator is consumed into the
//   dropped run, so it can't strand at the end of a line.
//
//   after plain WHITESPACE the label must be a SINGLE word, or it would
//   swallow a preceding value word — in "9% Elastane Inner:" it must match
//   "Inner:", never "Elastane Inner:". This is the Outer:/Inner: shape, which
//   runs its parts together with no separator at all.
//
// One or two spaces are tolerated before the colon ("Inside :"). Unicode
// (\p{L}) so translated labels in any script qualify.
const LABEL_WORD = "[\\p{L}][\\p{L}\\p{N}.\\-&]*";
const BREAK_RE = new RegExp(
  `(?<=\\S)(?:([,;/]\\s*)(${LABEL_WORD}(?:[ \\t]${LABEL_WORD}){0,3}[ \\t]{0,2}:)|(\\s+)([\\p{L}][\\p{L}.\\-/&]*\\s{0,2}:))`,
  "gu",
);

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
    const wsStart = m.index; // start of the separator/whitespace run before the label
    const labelStart = wsStart + (m[1] ?? m[3]).length;
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
    .map((l) => l.trim().replace(/[,;./]+$/, "").trim())
    .filter(Boolean);
  return lines.join("\n");
}

// =====================================================
// Colour-keyed compositions — the OTHER thing a "<label>: <fibres>" string
// can mean. Two shapes share one syntax:
//
//   "Top: 100% Cotton, Bottom: 60% Cotton 40% Polyester"   ONE garment,
//                                                          two parts →
//                                                          ONE label,
//                                                          two lines
//                                                          (above).
//   "Pink: 95% Cotton 5% Elastane, Grey melange: 57% …"    TWO garments in
//                                                          one pack → TWO
//                                                          labels, one per
//                                                          colour.
//
// Neither the colon nor the separator tells them apart: a survey of all 6181
// live styles found 107 multi-label compositions, and the comma shape is
// overwhelmingly garment parts (Top/Bottom, Upper/Sole, Outer/Lining, Part 1/
// Part 2). What DOES separate them is the label itself — a colour-keyed part
// is labelled with a colour THIS STYLE ACTUALLY CARRIES. Matching every label
// against the style's own colours split exactly the 13 two-composition packs
// and left all 94 garment-part styles alone (zero false positives), because
// "Sole" and "Lining" are never colours the style declares.
//
// Consumed by repetitionStyles (./render.ts) behind the per-layout
// `splitByComposition` opt-in — this module only decides whether a string IS
// colour-keyed, never whether a layout wants to split on it.
// =====================================================

export type CompositionPart = { label: string; text: string };

// A part label: at the start or after a separator, up to a colon, and never
// spanning one of the separators (so "Grey melange" survives whole but
// "…Elastane, Grey" can't be read as a label). One or two spaces before the
// colon are tolerated, matching the line-splitter above.
const PART_LABEL_RE = /(?:^|[,;/\n])[ \t]*([^:,;/\n]{1,32}?)[ \t]{0,2}:/gu;

// Split "<label>: <value>[, <label>: <value>]" into its parts. Returns [] when
// the string carries fewer than two labelled parts — a single composition, a
// lone descriptive label, or no colon at all. Label and value are trimmed of
// whitespace and of separators stranded at the boundary.
export function parseCompositionParts(text: string): CompositionPart[] {
  if (!text || !text.includes(":")) return [];
  const marks = [...text.matchAll(PART_LABEL_RE)];
  if (marks.length < 2) return [];
  const parts: CompositionPart[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const m = marks[i];
    const valueStart = m.index + m[0].length;
    const valueEnd = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const label = m[1].trim();
    const value = text
      .slice(valueStart, valueEnd)
      .trim()
      .replace(/^[,;/\s]+|[,;/.\s]+$/g, "")
      .trim();
    if (!label || !value) return [];
    parts.push({ label, text: value });
  }
  return parts;
}

// Comparison key for a colour name: case- and punctuation-insensitive, so
// "Grey melange" matches the style name's "(Grey melange)" and "LGM" matches
// "(LGM)". Deliberately NOT fuzzy — "LGM" must not match "Light Grey Melange"
// by guesswork; an operator who wants that writes the same word in both places.
export function normaliseColourKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Expand a set of colour keys with every DECLARED alias of the colours in it.
// The style name says "LGM" and the composition says "Grey melange"; they are
// one colour only because a person put both in the same alias group (see
// getColourAliases in settings/app-settings.ts). Nothing is inferred here —
// with no groups configured this is the identity, and matching stays exact.
function withAliases(known: Set<string>, aliases: ReadonlyArray<readonly string[]>): Set<string> {
  const out = new Set(known);
  for (const group of aliases) {
    const keys = group.map(normaliseColourKey).filter(Boolean);
    if (!keys.some((k) => known.has(k))) continue;
    for (const k of keys) out.add(k);
  }
  return out;
}

// The parts of a COLOUR-KEYED composition, or null when this string isn't one.
// Colour-keyed means: two or more labelled parts, and EVERY label is a colour
// the style itself declares (or a declared alias of one). One unmatched label
// disqualifies the whole string — a half-match is far more likely to be a
// garment-part composition that happens to share a word with a colour than a
// genuine per-colour pack.
export function splitCompositionByColour(
  text: string,
  knownColours: readonly string[],
  aliases: ReadonlyArray<readonly string[]> = [],
): CompositionPart[] | null {
  const parts = parseCompositionParts(text);
  if (parts.length < 2) return null;
  const declared = new Set(knownColours.map(normaliseColourKey).filter(Boolean));
  if (declared.size === 0) return null;
  const known = aliases.length > 0 ? withAliases(declared, aliases) : declared;
  return parts.every((p) => known.has(normaliseColourKey(p.label))) ? parts : null;
}

// =====================================================
// One fibre per line — {{compositionLines:<lang>}}.
//
// The part split above gives each labelled PART its own line. This goes one
// level finer and gives each FIBRE its own line, for narrow labels where
// "57% Cotton 38% Polyester 5% Elastane" can't fit across:
//
//   95% Cotton          Outer: 91% Polyester
//   5% Elastane         9% Elastane
//
// The delimiter is the PERCENTAGE, not a comma. Buyers write fibre lists both
// ways — "95% Cotton 5% Elastane" (space) and "82% Acrylic, 17% Polyester, 1%
// Elastane" (comma) — and the space-separated form is by far the more common,
// so splitting on commas would leave most values untouched. Breaking before
// each "NN%" clause handles both, and drops a comma stranded at the break.
//
// Applied ON TOP of the part split, per line, so a part label stays with its
// own first fibre. A line carrying fewer than two percentages is left exactly
// as it is — a fibre-free value ("Upper: Textile"), a single fibre, or a
// descriptive phrase never gains a break.
// =====================================================

// A percentage clause: "95%", "1.5 %", "1,5%". Buyers write decimals both ways.
const PERCENT_AT = /\d+(?:[.,]\d+)?\s*%/g;

// Split ONE line before each percentage after the first.
function splitFibreLine(line: string): string {
  const marks = [...line.matchAll(PERCENT_AT)];
  if (marks.length < 2) return line;
  const out: string[] = [];
  let start = 0;
  for (const m of marks.slice(1)) {
    // Trim back over the separator between the previous fibre and this one, so
    // "82% Acrylic, 17% …" doesn't leave the comma dangling at line end.
    const piece = line.slice(start, m.index).replace(/[\s,;/]+$/, "");
    if (piece.trim()) out.push(piece.trim());
    start = m.index;
  }
  const tail = line.slice(start).trim();
  if (tail) out.push(tail);
  return out.join("\n");
}

// Composition with every fibre on its own line. Runs the part split first, so
// a multi-part composition still separates its parts and each part's fibres
// then break within it. Idempotent: an already-split value has one percentage
// per line, so a second pass changes nothing.
export function formatCompositionFibreLines(text: string): string {
  if (!text) return text;
  return formatCompositionLines(text)
    .split("\n")
    .map(splitFibreLine)
    .join("\n");
}
