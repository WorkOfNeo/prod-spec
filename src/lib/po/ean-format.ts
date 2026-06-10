// Pull a human "colour" out of a PO variant label, e.g.
//   "A-S/M Colour A Black-Black, S/M" → "Black-Black"
//   "A-110 CM Colour A, 110 cm"       → "A"   (no colour name, just the code)
//   "Ø36xH50cm Colour A , One size"   → "A"
//   "A-S Black w silver lurex, S"     → "Black w silver lurex"  (fallback)
// Returns "" when the label carries no recognisable colour. Pure/plain so it
// can be used in client components.
export function colorFromVariantLabel(label: string | null | undefined): string {
  if (!label) return "";
  const m = label.match(/colou?r\s+([^\s,]+)\s*([^,]*)/i);
  if (m) {
    const code = m[1].trim();
    const name = m[2].trim();
    return name || code;
  }
  // Fallback for labels WITHOUT the "Colour" keyword. The recurring PO
  // pattern is "<article>-<size> <colour name>, <size>" — e.g.
  // "A-S Black w silver lurex, S" / "C-M Antrazit with silver lurex, M":
  // strip the "<article>-<size> " prefix and the ", <size>" suffix; what
  // remains is the colour name.
  const fb = label.match(/^\S+-\S+\s+(.+?),\s*[^,]+$/);
  return fb ? fb[1].trim() : "";
}
