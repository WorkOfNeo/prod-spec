import { db } from "@/lib/db";
import type { ProdSpecOutput } from "./config";

// =====================================================
// Info-area sizing (SERVER-ONLY — imports db).
//
// An "info area" output (its variant carries isInfoArea — set on the
// OutputLayout in the Output Builder) prints at a PER-STYLE switchable
// size. The pick lives on the per-output JSON (ProdSpecOutput):
//
//   • infoAreaSizeId set  → use that admin InfoAreaSize's dimensions,
//     resolved LIVE here so an admin edit to the size propagates to every
//     style that picked it.
//   • infoAreaSizeId absent/null, or the referenced size was deleted /
//     deactivated → fall back to the output's own widthMm/heightMm (the
//     one-time custom size, also the last-known snapshot of a picked size).
//
// Non-info-area outputs always print at widthMm/heightMm — unchanged.
//
// Resilient by design: this runs in the job runner and the preview routes,
// which existed before the info_area_sizes table. If the migration isn't
// applied yet (npm run db:deploy) the load degrades to an empty map and
// every output falls back to its stored dims — nothing crashes.
// =====================================================

export type InfoAreaSizeInfo = {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  active: boolean;
};

let warnedUnavailable = false;

// Map of EVERY info-area size by id (active and inactive), so a frozen pick
// to a now-inactive size still resolves at render time. One cheap query per
// job run / preview request — not hot enough to warrant caching.
export async function loadInfoAreaSizeMap(): Promise<Map<string, InfoAreaSizeInfo>> {
  try {
    const rows = await db.infoAreaSize.findMany({
      select: { id: true, name: true, widthMm: true, heightMm: true, active: true },
    });
    warnedUnavailable = false;
    return new Map(rows.map((r) => [r.id, r]));
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[info-area] could not load info-area sizes (is the info_area_sizes migration applied? npm run db:deploy): ${(err as Error).message}`,
      );
    }
    return new Map();
  }
}

// The active sizes the dropdown offers, smallest first. Resilient (empty on
// a missing table) so callers — the style page, settings list — never crash.
export async function listActiveInfoAreaSizes(): Promise<InfoAreaSizeInfo[]> {
  try {
    return await db.infoAreaSize.findMany({
      where: { active: true },
      orderBy: [{ widthMm: "asc" }, { heightMm: "asc" }, { name: "asc" }],
      select: { id: true, name: true, widthMm: true, heightMm: true, active: true },
    });
  } catch {
    return [];
  }
}

// The dimensions an output actually prints at. The ONE resolver shared by
// the runner and both preview routes, so the live preview, the generated
// PDF and the style-card readout can never disagree.
export function effectiveOutputDims(
  output: Pick<ProdSpecOutput, "widthMm" | "heightMm" | "infoAreaSizeId">,
  isInfoArea: boolean,
  sizeMap: Map<string, InfoAreaSizeInfo>,
): { widthMm: number; heightMm: number } {
  if (isInfoArea && output.infoAreaSizeId) {
    const size = sizeMap.get(output.infoAreaSizeId);
    if (size) return { widthMm: size.widthMm, heightMm: size.heightMm };
  }
  return { widthMm: output.widthMm, heightMm: output.heightMm };
}
