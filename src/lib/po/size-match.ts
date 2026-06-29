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

// True if a style `size` appears as a distinct token in a PO variant `label`
// — e.g. "S/M" in "A-S/M Colour A Black-Black, S/M". Boundaries treat "/" as
// part of a size token so "S" doesn't falsely match "S/M". Falls back to a
// normalised substring for distinctive (≥3-char) sizes, then to the bare
// numeric range — so a verbose customer size ("86–92 cm / 1½–2 år") still
// matches the range the PO prints ("86/92").
export function labelHasSize(label: string, size: string): boolean {
  const s = size.toLowerCase().trim();
  if (!s) return false;
  const re = new RegExp(`(^|[^a-z0-9/])${escapeRe(s)}([^a-z0-9/]|$)`, "i");
  if (re.test(label.toLowerCase())) return true;
  const ns = norm(size);
  if (ns.length >= 3 && norm(label).includes(ns)) return true;
  const key = sizeRangeKey(size);
  if (key) {
    const labelCanon = label.replace(/[–—-]/g, "/");
    const reKey = new RegExp(`(^|[^\\d])${escapeRe(key)}([^\\d]|$)`);
    if (reKey.test(labelCanon)) return true;
  }
  return false;
}
