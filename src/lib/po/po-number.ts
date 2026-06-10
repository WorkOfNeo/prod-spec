// Parse the numeric part of a PO reference. Accepts the forms operators
// paste — "C-PO63144", "C-PO 63144", bare "63144" — and returns the value
// of the LAST digit run, or null when there's none.
export function parsePoNumberValue(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
}
