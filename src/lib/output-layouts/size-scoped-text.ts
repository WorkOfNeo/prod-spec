// =====================================================
// Size-scoped text fields.
//
// Buyers fill some Pre-Order text columns as per-size lists keyed by the
// style's own size labels — the same "SIZE: value" convention as the
// barcode columns:
//
//   Customer Item No   "4-5 ÅR: 7307204, \n6-7 ÅR: 7307214, \n8 ÅR:7307213"
//   Description        "4-5 ÅR: HIPSTER 2PK ROSA 4-5 ÅR, 6-7 ÅR: …"
//
// When a layout repeats per size / per EAN / per carton, each repetition
// row should print ITS size's entry, not the whole list. This module is
// the pure parser+narrower repetitionStyles applies to those fields.
//
// Parsing anchors on the style's KNOWN size labels followed by ":" —
// never on bare commas — so values may contain commas, newlines, or even
// the size text itself ("… ROSA 4-5 ÅR" has no trailing colon and can't
// open a new entry). Labels match space-insensitively and case-
// insensitively ("4-5ÅR:" ≡ "4-5 ÅR:").
//
// Fallbacks keep the raw value verbatim (never blank a printed field):
//   • no size anchors in the text → not a per-size list, print as-is
//   • anchors exist but none match the row's size(s) → print as-is
// =====================================================

// Space-insensitive, case-insensitive size key ("4-5 ÅR" ≡ "4-5ÅR").
function sizeKey(label: string): string {
  return label.replace(/\s+/g, "").toUpperCase();
}

type SizeAnchor = { key: string; start: number; valueStart: number };

// Every "<size>:" occurrence in the text whose <size> is one of the style's
// known labels. A candidate label is the text between the previous
// separator (comma / newline / start) and the colon.
function findAnchors(text: string, knownKeys: ReadonlySet<string>): SizeAnchor[] {
  const anchors: SizeAnchor[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ":") continue;
    let segStart = i - 1;
    while (segStart >= 0 && text[segStart] !== "," && text[segStart] !== "\n") segStart--;
    segStart++;
    const key = sizeKey(text.slice(segStart, i));
    if (!key || !knownKeys.has(key)) continue;
    // Skip leading whitespace so the anchor's `start` marks where the
    // previous entry's value ends.
    while (segStart < i && /\s/.test(text[segStart])) segStart++;
    anchors.push({ key, start: segStart, valueStart: i + 1 });
  }
  return anchors;
}

// Narrow a possibly per-size text value to the given row size(s).
// `allSizeLabels` are the style's full size run (the anchor vocabulary);
// `rowSizeLabels` the size(s) this repetition row was narrowed to.
// Multiple matches (a carton grouping several sizes) join with ", ".
export function narrowSizeScopedText(
  raw: string | undefined,
  allSizeLabels: readonly string[],
  rowSizeLabels: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw;
  if (!text.trim() || rowSizeLabels.length === 0) return text;
  const knownKeys = new Set(allSizeLabels.map(sizeKey).filter(Boolean));
  if (knownKeys.size === 0) return text;

  const anchors = findAnchors(text, knownKeys);
  if (anchors.length === 0) return text;

  const wanted = new Set(rowSizeLabels.map(sizeKey));
  const picked: string[] = [];
  for (let a = 0; a < anchors.length; a++) {
    if (!wanted.has(anchors[a].key)) continue;
    const end = a + 1 < anchors.length ? anchors[a + 1].start : text.length;
    const value = text
      .slice(anchors[a].valueStart, end)
      .trim()
      // The next entry's separator (or a list-style trailing comma) belongs
      // to the list syntax, not the value.
      .replace(/[,\s]+$/, "");
    if (value) picked.push(value);
  }
  return picked.length > 0 ? picked.join(", ") : text;
}
