import { db } from "@/lib/db";
import { layoutVariantKey } from "@/lib/output-layouts/variants";

// =====================================================
// Clean removal of deleted Output Builder layouts from the Prod Specs that
// reference them. A layout is linked to a ProdSpec only by a
// `layout:<id>` entry inside the ProdSpec.outputs JSON array (no FK), so
// when a layout is deleted we strip those entries here — the layout truly
// "drops" from the spec instead of lingering as a stale key the runner has
// to skip.
//
// Call AFTER the OutputLayout row(s) are deleted. Generated PDFs live on
// JobAsset rows tied to Jobs (not to layouts or to ProdSpec.outputs), so
// they are never touched by this — already-produced files are kept.
// =====================================================

export async function detachLayoutsFromProdSpecs(
  layoutIds: string[],
): Promise<{ specsUpdated: number; specIds: string[] }> {
  if (layoutIds.length === 0) return { specsUpdated: 0, specIds: [] };
  const keys = new Set(layoutIds.map((id) => layoutVariantKey(id)));

  const specs = await db.prodSpec.findMany({ select: { id: true, outputs: true } });
  const changed: string[] = [];

  for (const spec of specs) {
    const raw = spec.outputs;
    // Only the array shape can carry layout:<id> keys — the legacy object
    // shape (keyed by DocType) never does, so it can't reference a layout.
    if (!Array.isArray(raw)) continue;
    // Filter the RAW entries so untouched outputs keep their exact stored
    // JSON (no Zod re-normalisation of siblings as a side effect of delete).
    const kept = raw.filter((o) => {
      const key = o && typeof o === "object" ? (o as { variantKey?: unknown }).variantKey : undefined;
      return typeof key !== "string" || !keys.has(key);
    });
    if (kept.length === raw.length) continue;
    await db.prodSpec.update({ where: { id: spec.id }, data: { outputs: kept } });
    changed.push(spec.id);
  }

  return { specsUpdated: changed.length, specIds: changed };
}
