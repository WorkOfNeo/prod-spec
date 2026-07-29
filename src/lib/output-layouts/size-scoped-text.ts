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
// Parsing anchors on the style's KNOWN size labels followed by a
// separator — ":" by default; the carton-qty column uses "=" instead
// ("4-5ÅR=1040, 6-7ÅR=1050") — never on bare commas — so values may
// contain commas, newlines, or even the size text itself ("… ROSA
// 4-5 ÅR" has no trailing colon and can't open a new entry). Labels
// match space-insensitively and case-insensitively ("4-5ÅR:" ≡ "4-5 ÅR:").
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

// Every "<size><sep>" occurrence in the text whose <size> is one of the
// style's known labels. A candidate label is the text between the previous
// delimiter (comma / newline / start) and the separator char.
function findAnchors(
  text: string,
  knownKeys: ReadonlySet<string>,
  separators: readonly string[],
): SizeAnchor[] {
  const anchors: SizeAnchor[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!separators.includes(text[i])) continue;
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
  // Char(s) that close a size label. Customer Item No / Description use
  // ":", the carton-qty column uses "=" — pass both there.
  separators: readonly string[] = [":"],
): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw;
  if (!text.trim() || rowSizeLabels.length === 0) return text;
  const knownKeys = new Set(allSizeLabels.map(sizeKey).filter(Boolean));
  if (knownKeys.size === 0) return text;

  const anchors = findAnchors(text, knownKeys, separators);
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

// =====================================================
// Strategy 2 — UNLABELLED per-size item lists.
//
// The narrowing above needs an explicit "<size><sep>" anchor. Buyers also
// fill a description column as a plain comma-separated list where the size
// is a WORD INSIDE each item, with no separator at all:
//
//   "Kalsonger Svart S 5-pack, Kalsonger Svart M 5-pack, … Kalsonger Svart
//    XL\n5-pack, Kalsonger Svart XXL\n5-pack"
//
// findAnchors sees no anchors there and hands the whole list back, so every
// repetition row printed all five entries. pickSizeItems is the opt-in
// second pass behind {{description:size}}.
//
// Deliberately NOT automatic: unlike an anchored list, "a comma list whose
// items happen to contain size words" is a guess, and applying it to every
// repeating layout would change what already-published layouts print. The
// token argument makes it a per-block decision.
//
// Matching rules:
//   • split on commas only (newlines inside an item are wrap artefacts —
//     Monday wraps long values, e.g. "XL\n5-pack" — so they're normalised
//     to a space, never treated as item boundaries);
//   • an item belongs to a size when that size appears as a WHOLE WORD;
//     longest label first, so "XXL" claims its item before "XL" or "L" can;
//   • the size word STAYS in the printed text — it's the buyer's own copy
//     for that size, reproduced verbatim.
//
// Same fallback contract as above: anything ambiguous prints the raw value
// rather than blanking or guessing.
//   • fewer than 2 items → not a list, print as-is
//   • no item matches the row's size(s) → print as-is
// Positional mapping (item N ⇒ size N) is deliberately NOT attempted, the
// same product decision the barcode parser makes: a list without labels is
// never guessed at.
// =====================================================

// Whole-word test for a size label inside an item. The label may contain
// regex metacharacters ("4-5 ÅR", "86/92"), so it's escaped; \b is unreliable
// against "/" and non-ASCII, so boundaries are asserted as "not a letter or
// digit" on either side. Space-insensitive to match sizeKey's semantics.
function itemHasSizeWord(item: string, label: string): boolean {
  const collapsed = item.replace(/\s+/g, " ");
  const esc = label.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow the label's internal spaces to match any run of whitespace.
  const pattern = esc.replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu").test(collapsed);
}

// Narrow an unlabelled comma-separated per-size list to the row's size(s).
// `allSizeLabels` is the style's full size run (the label vocabulary);
// `rowSizeLabels` the size(s) this repetition row covers. Multiple matches
// (an assortment row covering the whole run) join with ", " — so a
// non-repeating layout keeps printing the full list.
export function pickSizeItems(
  raw: string | undefined,
  allSizeLabels: readonly string[],
  rowSizeLabels: readonly string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.trim() || rowSizeLabels.length === 0) return raw;

  const items = raw
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (items.length < 2) return raw;

  // Longest label first so "XXL" wins its item before "XL" / "L" is tried.
  const byLength = [...new Set(allSizeLabels.filter((l) => l.trim()))].sort(
    (a, b) => b.length - a.length,
  );
  const claimed = new Map<string, string>(); // item → the size that owns it
  for (const item of items) {
    const hit = byLength.find((label) => itemHasSizeWord(item, label));
    if (hit) claimed.set(item, hit);
  }
  if (claimed.size === 0) return raw;

  const wantedKeys = new Set(rowSizeLabels.map((l) => l.replace(/\s+/g, "").toUpperCase()));
  const picked = items.filter((item) => {
    const owner = claimed.get(item);
    return owner !== undefined && wantedKeys.has(owner.replace(/\s+/g, "").toUpperCase());
  });
  // Nothing matched, or EVERY item matched (no repetition / an assortment row
  // covering the whole run) ⇒ nothing was narrowed. Hand back the raw value
  // byte-for-byte rather than a re-joined copy, so {{description:size}} outside
  // a repetition is indistinguishable from bare {{description}} — including any
  // wrap newlines the buyer's text carries.
  if (picked.length === 0 || picked.length === items.length) return raw;
  return picked.join(", ");
}
