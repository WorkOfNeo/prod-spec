// =====================================================
// Salling's Customer Item No column — a CARTON article number and a
// per-size PRODUCT article number packed into one cell. Backs
// {{customerItemNo:salling}} and {{customerItemNo:sallingCarton}}.
//
// Three shapes occur live, and a layout author places ONE token for all of
// them, so the parser has to read all three:
//
//   carton + product  "Carton: 933977900, Product: S: 933977001, M: 933977002, …"
//   plain positional  "924126001, 924126002, 924126003, 924126004, 924126005"
//   carton only       "Carton: 933985001"
//
// The plain form is the reason this module exists rather than leaning on
// narrowSizeScopedText alone: it carries no size labels, so the Nth value
// belongs to the Nth size and nothing else identifies it.
//
// ⚠️ POSITIONAL MATCHING IS A DELIBERATE EXCEPTION HERE. size-scoped-text.ts
// refuses it on principle ("a list without labels is never guessed at", the
// same call the barcode parser makes) because applying it to every repeating
// layout would silently change what published layouts print. This module is
// different on three counts: it is opt-in behind an explicit token argument,
// it is scoped to one customer whose column was surveyed end to end, and it
// only fires when the value count matches the size run EXACTLY. A list of a
// different length resolves to "" rather than to a guess — a wrong article
// number on a label is indistinguishable from a right one and ships, whereas
// a blank is caught in review.
// =====================================================

import { hasSizeAnchors, narrowSizeScopedText, sizeKey } from "./size-scoped-text";

// "Carton: 933977900" — the heading and its value, up to the entry
// delimiter. Anchored to the start of an entry so a stray "carton" inside a
// product value can't be mistaken for the heading.
const CARTON_ENTRY = /(?:^|[,\n])[ \t]*carton[ \t]*:[ \t]*([^,\n]*)/i;

// The "Product:" heading that introduces the per-size list. Its value is the
// whole rest of the cell, so unlike the carton entry it is stripped, not
// captured.
const PRODUCT_HEADING = /(?:^|[,\n])[ \t]*product[ \t]*:[ \t]*/i;

// The carton article number, or "" when the cell carries none (the plain
// positional form). Row-independent: one carton number per style.
export function resolveSallingCartonItemNo(raw: string | undefined | null): string {
  if (!raw?.trim()) return "";
  return (CARTON_ENTRY.exec(raw)?.[1] ?? "").trim();
}

// The PRODUCT article number for the row's size(s), or "" when the cell
// carries none (a carton-only value) or the row's size can't be identified.
// Several sizes on one row (a carton grouping) join with ", ", mirroring
// narrowSizeScopedText.
export function resolveSallingItemNo(
  raw: string | undefined | null,
  allSizeLabels: readonly string[],
  rowSizeLabels: readonly string[],
): string {
  if (!raw?.trim()) return "";

  // Drop the carton entry and the "Product:" heading, leaving just the list.
  let rest = raw.replace(CARTON_ENTRY, "").replace(PRODUCT_HEADING, "");
  rest = rest.replace(/^[\s,]+/, "").replace(/[\s,]+$/, "");
  if (!rest) return ""; // carton-only

  if (rowSizeLabels.length === 0 || allSizeLabels.length === 0) return "";

  // Labelled list — the size labels themselves say which value is which.
  if (hasSizeAnchors(rest, allSizeLabels)) {
    const narrowed = narrowSizeScopedText(rest, allSizeLabels, rowSizeLabels);
    // narrowSizeScopedText hands the value back unchanged when no anchor
    // matched the row. Anchors exist here, so that means this row's size
    // simply isn't in the list — an honest gap, not a value to print.
    return narrowed === undefined || narrowed === rest ? "" : narrowed;
  }

  // Plain positional list — see the exception note at the top of the file.
  const values = rest
    .split(/[,\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length !== allSizeLabels.length) return "";

  const keys = allSizeLabels.map(sizeKey);
  const picked: string[] = [];
  for (const label of rowSizeLabels) {
    const idx = keys.indexOf(sizeKey(label));
    if (idx >= 0 && values[idx]) picked.push(values[idx]);
  }
  return picked.join(", ");
}
