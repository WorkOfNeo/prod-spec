import { db } from "@/lib/db";
import { normalizeImageSlug } from "./image-slug";

// =====================================================
// The image library — artwork placed by {{image:<slug>}} (SERVER-ONLY).
//
// A shared pool of named pictures, DB-managed under /settings/images. Any
// layout can place any number of them, and the same picture is reused
// across layouts — so a mark that appears on eight Coop layouts is
// uploaded once and corrected once.
//
// This is deliberately NOT {{logo:custom}}: that token is a single image
// stored on the layout row (OutputLayout.customLogo), which is why a
// layout needing a SECOND picture had nowhere to put it. Both keep
// working; the library is where new artwork should go.
//
// Rows are cached briefly and keyed by slug; `image` holds raw SVG markup
// or a data URL, normalized here to a data URL so the renderer emits a
// uniform <img src> and the PDF needs no network fetch. Mirrors
// loadCertificates / loadWashcareSymbols.
// =====================================================

export type ResolvedLayoutImage = {
  slug: string;
  name: string;
  dataUrl: string | null;
};

export type LayoutImageMap = Map<string, ResolvedLayoutImage>;

const CACHE_TTL_MS = 30_000;

let cached: { at: number; map: LayoutImageMap } | null = null;

export async function loadLayoutImages(): Promise<LayoutImageMap> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;

  const rows = await db.layoutImage.findMany({ where: { active: true } });
  const map: LayoutImageMap = new Map();
  for (const row of rows) {
    const raw = row.image ?? "";
    const dataUrl = !raw
      ? null
      : raw.startsWith("data:")
        ? raw
        : `data:image/svg+xml;base64,${Buffer.from(raw, "utf-8").toString("base64")}`;
    map.set(normalizeImageSlug(row.slug), { slug: row.slug, name: row.name, dataUrl });
  }
  cached = { at: Date.now(), map };
  return map;
}

// Bust the cache from the admin API after writes so the next render sees
// the change immediately rather than waiting out the TTL.
export function invalidateLayoutImageCache(): void {
  cached = null;
}

// A deactivated row is absent from the map (loadLayoutImages filters on
// active), so it resolves exactly like a slug that never existed — the
// renderer prints the `missing` chip and approval stays blocked. That's the
// point: switching a picture off must be visible on the proof, not silent.
export function findLayoutImage(map: LayoutImageMap, slug: string): ResolvedLayoutImage | null {
  return map.get(normalizeImageSlug(slug)) ?? null;
}
