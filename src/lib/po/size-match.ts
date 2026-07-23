// Matching a style's declared size against a PO variant label. Pure + free of
// server deps so it's unit-testable (the resolver imports `db`, so its helpers
// can't be exercised directly in a test). Used by resolve-style-eans.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull the leading numeric size RANGE from a string, separators unified to "/"
// — "86–92 cm / 1½–2 år" → "86/92", "98/104" → "98/104", "S/M" / "L" → null.
// Range-only on purpose: single numbers are already covered by the normalised
// substring check and a bare number would risk matching the wrong bracket.
export function sizeRangeKey(s: string): string | null {
  const m = s.match(/(\d+)\s*[/\-–—]\s*(\d+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// The size-bearing portion of a PO variant label. A Contrast label prints the
// canonical size LAST, after the final comma:
//   "800406 .L-XL Light Grey Melange, XL"  → "XL"
// Everything before that comma — notably the "<colour code>-" prefix — can
// carry a stray size letter: ".L-" is the Light-Grey colour code, whose "L"
// (bounded by "." and "-") otherwise reads as size L, so EVERY size row of a
// ".L" colourway falsely matches "L". Scanning only the trailing segment keeps
// a colour code from masquerading as a size. Labels with no trailing comma
// (bare sizes passed by eanForSize, other PO layouts) are matched whole — the
// pre-existing behaviour, so nothing regresses.
function sizeHaystack(label: string): string {
  const i = label.lastIndexOf(",");
  if (i === -1) return label;
  return label.slice(i + 1).trim() || label;
}

// True if a style `size` appears as a distinct token in a PO variant `label`
// — e.g. "S/M" in "A-S/M Colour A Black-Black, S/M". Boundaries treat "/" as
// part of a size token so "S" doesn't falsely match "S/M". Falls back to a
// normalised substring for distinctive (≥3-char) sizes, then to the bare
// numeric range — so a verbose customer size ("86–92 cm / 1½–2 år") still
// matches the range the PO prints ("86/92"). Matching is scoped to the label's
// trailing size segment (see sizeHaystack) so a "<colour code>-" prefix can't
// masquerade as a size.
export function labelHasSize(label: string, size: string): boolean {
  const s = size.toLowerCase().trim();
  if (!s) return false;
  const hay = sizeHaystack(label);
  const re = new RegExp(`(^|[^a-z0-9/])${escapeRe(s)}([^a-z0-9/]|$)`, "i");
  if (re.test(hay.toLowerCase())) return true;
  const ns = norm(size);
  if (ns.length >= 3 && norm(hay).includes(ns)) return true;
  const key = sizeRangeKey(size);
  if (key) {
    const labelCanon = hay.replace(/[–—-]/g, "/");
    const reKey = new RegExp(`(^|[^\\d])${escapeRe(key)}([^\\d]|$)`);
    if (reKey.test(labelCanon)) return true;
  }
  return false;
}
