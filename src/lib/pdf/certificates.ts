import { db } from "@/lib/db";

// =====================================================
// Certificate logos — DB-managed via /settings/certificates.
// Each Certificate row carries its own logo (raw SVG or a data URL) so
// the admin can update the catalogue without a deploy.
//
// At render time we fetch the active set, build a name→data:URL map
// (keyed by lowercase name for case-insensitive matching against a
// Style's certificates list), and cache it for a short TTL. Mirrors
// loadWashcareSymbols.
// =====================================================

export type ResolvedCertificate = {
  name: string;
  dataUrl: string | null;
};

export type CertificateMap = Map<string, ResolvedCertificate>;

const CACHE_TTL_MS = 30_000;

let cached: { at: number; map: CertificateMap } | null = null;

export async function loadCertificates(): Promise<CertificateMap> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;

  const rows = await db.certificate.findMany({ where: { active: true } });
  const map: CertificateMap = new Map();
  for (const row of rows) {
    // `logo` holds either raw SVG markup or a data URL (PNG/JPG/SVG
    // base64), same dual storage as WashSymbol.svg. Store data URLs
    // as-is; wrap raw SVG into a base64 data URL so templates can use
    // a uniform <img src>.
    const raw = row.logo ?? "";
    const dataUrl = !raw
      ? null
      : raw.startsWith("data:")
        ? raw
        : `data:image/svg+xml;base64,${Buffer.from(raw, "utf-8").toString("base64")}`;
    // Key by lowercase name for case-insensitive matching — the Style's
    // certificates come from a free-text Monday column ("FSC, OEKOTEX").
    map.set(row.name.toLowerCase(), { name: row.name, dataUrl });
  }
  cached = { at: Date.now(), map };
  return map;
}

// Bust the cache from the admin API after writes so the next render
// sees the change immediately rather than waiting out the TTL.
export function invalidateCertificateCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------
// Normalized lookup — used by the Output Builder's {{cert:<source>}}
// tokens. Library names are free text ("OEKO-TEX", "OEKOTEX", "F.S.C.")
// while token args are limited to [a-z0-9-], so both sides reduce to
// bare lowercase alphanumerics before comparing.
// ---------------------------------------------------------------------

export function normalizeCertKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findCertificate(map: CertificateMap, source: string): ResolvedCertificate | null {
  const want = normalizeCertKey(source);
  if (!want) return null;
  for (const entry of map.values()) {
    if (normalizeCertKey(entry.name) === want) return entry;
  }
  return null;
}
