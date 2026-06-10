// =====================================================
// Placeholder detection — the ship-gate's eyes.
//
// Templates render honest gaps instead of dropping content silently:
//   • <span class="missing">     — wash-care symbol with no artwork / unknown token
//   • <span class="cert-missing"> — certificate declared but no logo in the library
//   • <div class="barcode-missing"> — no/invalid EAN where bars belong
//
// Those tiles are exactly right for REVIEW (the gap is visible on the
// proof) and exactly wrong for PRINT. The runner counts them in the
// rendered HTML and persists the count on the JobAsset; approval is
// blocked while any asset's count is > 0.
//
// The classes are our own template vocabulary — counting class attributes
// (not CSS rules) keeps this exact: `.missing` in a <style> block doesn't
// match, `class="missing"` in markup does.
// =====================================================

const MARKER_CLASS_RE =
  /class="(?:[^"]*\s)?(?:missing|barcode-missing|cert-missing)(?:\s[^"]*)?"/g;

export function countPlaceholderMarkers(html: string): number {
  return (html.match(MARKER_CLASS_RE) ?? []).length;
}
