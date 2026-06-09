// Helpers for sanitizing per-language translation maps that come in
// from admin API endpoints. Used by WashSymbol, Country, ProdSpec, etc.
//
// Behavior:
//   - keys lowercased (so the form sends "EN" or "En" and we store "en")
//   - whitespace-only values dropped (so an empty input field doesn't
//     leave a "lang: '   '" entry behind)
//   - returns Prisma-Json-castable object (typed `unknown as object`
//     at the call site; the helper itself returns a flat string map)
export function sanitizeTranslations(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out[k.toLowerCase()] = trimmed;
  }
  return out;
}
