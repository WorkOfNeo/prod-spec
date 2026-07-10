// Pure parsing for the Monday barcode-column FALLBACK — free of server deps
// (no `db`) so it's unit-testable. The db-backed resolver that consumes these
// helpers lives in ./monday-barcode-fallback.
//
// The Pre-Order "Barcode Number" / "Carton Barcode number 1" columns are free
// text a buyer types, so they arrive in a few shapes:
//   "Solid - S:707…678, M: 707…661, L: 707…654"   (colour prefix + SIZE:EAN)
//   "M/L: 707…999, XL/XXL: 707…001, 3XL: 707…982"  (labelled pairs, no colour)
//   "7070001353354"                                (single bare EAN)
//   "…\nAssort - 7070001870127"                    (assortment / pack EAN)
//
// Per the product decision we REQUIRE size labels: a bare list of several EANs
// with no "SIZE:" prefixes is NOT positionally guessed (it lands in bareEans,
// which the resolver only honours for a single-size style). Every value is
// validated as an EAN-13 (13 digits + check digit); invalid tokens are dropped
// into `invalid` for audit, never used — a bad check digit fails bwip-js at render.

import { labelHasSize } from "./size-match";

// EAN-13 check-digit validation. Digits at even indices (0-based) weight 1,
// odd indices weight 3; the 13th digit is the check.
export function isValidEan13(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(d[12]);
}

// Normalise a raw token to a valid 13-digit EAN, or null if it isn't one.
function normEan(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length === 13 && isValidEan13(d) ? d : null;
}

export type ParsedBarcodeField = {
  // Labelled "SIZE: EAN" pairs (colour prefix already stripped).
  bySize: Array<{ sizeKey: string; ean: string }>;
  // Bare EANs with no size label — only used for the single-size exception.
  bareEans: string[];
  // The "Assort - <EAN>" value, if present (assortment / master carton EAN).
  assort: string | null;
  // Non-empty tokens that failed EAN-13 validation (audit only).
  invalid: string[];
};

// Parse one field's free text into labelled pairs + assort + bare EANs.
export function parseBarcodeField(text: string): ParsedBarcodeField {
  const out: ParsedBarcodeField = { bySize: [], bareEans: [], assort: null, invalid: [] };
  if (!text) return out;

  for (const rawLine of text.split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // "Assort - 7070001870127" / "Assort: …" — the pack/assortment EAN.
    const assortMatch = line.match(/^assort\b\s*[:–—-]?\s*(.+)$/i);
    if (assortMatch) {
      const e = normEan(assortMatch[1]);
      if (e) out.assort = e;
      else if (assortMatch[1].trim()) out.invalid.push(assortMatch[1].trim());
      continue;
    }

    // Strip an optional leading colour label: "Solid - S:…, M:…". The colour
    // token has no ":" (so it isn't itself a SIZE:EAN pair) and the remainder
    // must carry a ":" pair to qualify as a prefix rather than a size range.
    let payload = line;
    const prefix = line.match(/^([^:]+?)\s+[-–—]\s+(.+)$/);
    if (prefix && prefix[2].includes(":")) payload = prefix[2];

    for (const rawItem of payload.split(",")) {
      const item = rawItem.trim();
      if (!item) continue;
      // Labelled "SIZE: EAN" — size can contain "/" and "-" (e.g. "M/L", "41-46").
      // The value is captured loosely (buyers add trailing "." / stray text);
      // normEan strips non-digits and validates the check digit, so only a real
      // EAN-13 lands in bySize — anything else is flagged invalid.
      const m = item.match(/^(.+?)\s*:\s*(.+)$/);
      if (m) {
        const sizeKey = m[1].trim();
        const e = normEan(m[2]);
        if (e) out.bySize.push({ sizeKey, ean: e });
        else out.invalid.push(item);
        continue;
      }
      // Unlabelled token — a bare EAN (kept only for the single-size case) or junk.
      const e = normEan(item);
      if (e) out.bareEans.push(e);
      else out.invalid.push(item);
    }
  }
  return out;
}

// Look up the EAN for a style size among a field's labelled pairs. Reuses the
// same size matcher the PO scrape uses so verbose customer sizes
// ("86–92 cm / 1½–2 år") still match the buyer's shorthand ("86/92"). Matches
// in either direction because we don't know which side is more verbose.
export function eanForSize(
  size: string,
  pairs: Array<{ sizeKey: string; ean: string }>,
): string | null {
  const hit = pairs.find((p) => labelHasSize(size, p.sizeKey) || labelHasSize(p.sizeKey, size));
  return hit?.ean ?? null;
}
