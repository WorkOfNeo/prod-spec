// =====================================================
// Image-library slugs — the CLIENT-SAFE half of {{image:<slug>}}.
//
// The slug is the whole contract between a published layout definition and
// the library row that supplies its artwork, so publish validation (client
// + server), the settings dialog and the render-time lookup must agree on
// exactly one alphabet. They all reduce through here.
//
// Must stay free of server imports — token-meta.ts and the settings UI
// import it. The DB-backed loader lives in images.ts.
// =====================================================

// Lowercase letters, digits and hyphens. Matches what TOKEN_RE will carry
// as an argument, so a valid slug is always typeable in a token.
export const IMAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Guard against a hand-edited row: strip anything that couldn't have been
// typed in a token, so a stray capital or space in the library can't make a
// picture unreachable.
export function normalizeImageSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// Suggest a slug from a display name — what the settings dialog prefills
// ("Coop hanger mark" → "coop-hanger-mark").
export function slugifyImageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
