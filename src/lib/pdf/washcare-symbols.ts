import { db } from "@/lib/db";
import { toLaunderingAction, type LaunderingAction } from "@/lib/care-labels/actions";

// =====================================================
// Wash-care symbols — DB-managed via /settings/washcare-symbols.
// Each WashSymbol row carries its own SVG markup so the admin can update
// the catalogue without touching code or deploying.
//
// At render time we fetch the active set, build a code→data:URL map, and
// cache it in memory for a short TTL. Refresh is automatic — uploads
// happen rarely and the TTL is short enough that they appear in the
// next render without manual flushing.
// =====================================================

export type WashcareSymbolMap = Map<string, ResolvedSymbol>;

export type ResolvedSymbol = {
  code: string;
  name: string;
  dataUrl: string | null;
  mondayValue: string | null;
  // Laundering action this symbol concerns + whether it's a prohibition.
  // Drives action-based care-instruction suppression on care-label-02.
  action: LaunderingAction | null;
  restrictive: boolean;
};

const CACHE_TTL_MS = 30_000;

let cached: { at: number; map: WashcareSymbolMap } | null = null;

// Normalised lookup key for a Monday wash-care token: trim, collapse
// whitespace, lowercase, strip a trailing ".", and fold the single-glyph
// "℃" (U+2103) to "°c". The Pre-Order dropdown carries variants of the
// same instruction ("Wash at or below 30℃" AND "Wash at or below 30℃.")
// that must resolve to one symbol without the catalogue needing one row
// per punctuation variant. Exact code/mondayValue matches always win —
// this is the fallback key.
export function normalizeWashToken(token: string): string {
  return token
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .replace(/℃/g, "°c")
    .toLowerCase();
}

// Resolve one token: exact code/mondayValue first, normalised fallback after.
export function getWashcareSymbol(
  map: WashcareSymbolMap,
  token: string,
): ResolvedSymbol | undefined {
  return map.get(token) ?? map.get(normalizeWashToken(token));
}

// Monday's dropdown `text` joins selected labels with ", " — but several
// labels THEMSELVES contain ", " ("Dry Clean, Any Solvent"), so the naive
// comma split in the mapper can shear one selection into two bogus tokens.
// Re-join: greedily merge adjacent unresolved fragments when the joined
// string resolves against the catalogue. Tokens that already resolve (or
// never resolve, even joined) pass through unchanged.
export function rejoinWashTokens(tokens: string[], map: WashcareSymbolMap): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (getWashcareSymbol(map, tokens[i])) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }
    // Try the longest join first so "A, B, C" labels win over "A, B".
    let merged: { token: string; consumed: number } | null = null;
    for (let end = tokens.length; end > i + 1; end--) {
      const candidate = tokens.slice(i, end).join(", ");
      if (getWashcareSymbol(map, candidate)) {
        merged = { token: candidate, consumed: end - i };
        break;
      }
    }
    if (merged) {
      out.push(merged.token);
      i += merged.consumed;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

export async function loadWashcareSymbols(): Promise<WashcareSymbolMap> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;

  const rows = await db.washSymbol.findMany({ where: { active: true } });
  const map = new Map<string, ResolvedSymbol>();
  for (const row of rows) {
    // The `svg` column despite its name can hold either:
    //   - Raw SVG markup ("<svg …>…</svg>")  — preferred, vector, crisp at any print size
    //   - A data URL ("data:image/png;base64,…" or "data:image/svg+xml;base64,…")
    //     — used by PNG / JPG uploads. We store these as-is so the runtime
    //     doesn't have to re-encode on every render.
    const raw = row.svg ?? "";
    const dataUrl = !raw
      ? null
      : raw.startsWith("data:")
        ? raw
        : `data:image/svg+xml;base64,${Buffer.from(raw, "utf-8").toString("base64")}`;
    const resolved: ResolvedSymbol = {
      code: row.code,
      name: row.name,
      dataUrl,
      mondayValue: row.mondayValue,
      action: toLaunderingAction(row.action),
      restrictive: row.restrictive,
    };
    // Index by `code` (primary), `mondayValue` (secondary), then their
    // normalised forms (tertiary — punctuation/glyph variants). Exact keys
    // are set first and never clobbered by normalised ones.
    map.set(row.code, resolved);
    if (row.mondayValue && !map.has(row.mondayValue)) {
      map.set(row.mondayValue, resolved);
    }
    const normCode = normalizeWashToken(row.code);
    if (!map.has(normCode)) map.set(normCode, resolved);
    if (row.mondayValue) {
      const normMv = normalizeWashToken(row.mondayValue);
      if (!map.has(normMv)) map.set(normMv, resolved);
    }
  }
  cached = { at: Date.now(), map };
  return map;
}

// Bust the cache from the admin API after writes so the next render
// sees the change immediately rather than waiting out the TTL.
export function invalidateWashcareSymbolCache(): void {
  cached = null;
}

// Resolve a single token (either our code or Monday's value) to a symbol.
export async function resolveWashcareSymbol(token: string): Promise<ResolvedSymbol | null> {
  const map = await loadWashcareSymbols();
  return map.get(token) ?? null;
}

// Canonical list of standard codes — used by the "Seed standard set"
// admin action to pre-populate the catalogue. Names are short labels;
// admins can rename and upload the SVG afterwards. `action` + `restrictive`
// classify each symbol for action-based care-instruction suppression: a
// `restrictive` ("Do not …") symbol removes care lines sharing its action.
export const STANDARD_WASHCARE_SYMBOLS: Array<{
  code: string;
  name: string;
  action: LaunderingAction | null;
  restrictive: boolean;
}> = [
  { code: "wash30", name: "Wash at 30°C", action: "WASHING", restrictive: false },
  { code: "wash40", name: "Wash at 40°C", action: "WASHING", restrictive: false },
  { code: "wash60", name: "Wash at 60°C", action: "WASHING", restrictive: false },
  { code: "wash_hand", name: "Hand wash", action: "WASHING", restrictive: false },
  { code: "wash_no", name: "Do not wash", action: "WASHING", restrictive: true },
  { code: "bleach_no", name: "Do not bleach", action: "BLEACHING", restrictive: true },
  { code: "bleach_oxygen", name: "Oxygen bleach only", action: "BLEACHING", restrictive: false },
  { code: "tumble_low", name: "Tumble dry low", action: "TUMBLE_DRYING", restrictive: false },
  { code: "tumble_normal", name: "Tumble dry normal", action: "TUMBLE_DRYING", restrictive: false },
  { code: "tumble_no", name: "Do not tumble dry", action: "TUMBLE_DRYING", restrictive: true },
  { code: "iron_low", name: "Iron low", action: "IRONING", restrictive: false },
  { code: "iron_medium", name: "Iron medium", action: "IRONING", restrictive: false },
  { code: "iron_high", name: "Iron high", action: "IRONING", restrictive: false },
  { code: "iron_no", name: "Do not iron", action: "IRONING", restrictive: true },
  { code: "dryclean", name: "Dry clean", action: "DRY_CLEANING", restrictive: false },
  { code: "dryclean_no", name: "Do not dry clean", action: "DRY_CLEANING", restrictive: true },
];
