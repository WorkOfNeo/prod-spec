import { db } from "@/lib/db";
import { getVariant } from "@/lib/pdf/template-registry";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";

// =====================================================
// Re-stamp JobAsset.fileName from a layout's CURRENT file-name template —
// per DOCUMENT, without re-rendering anything.
//
// Why this is not fixOutputFileNames. That sweep walks supplier-send queue
// ROWS, and a row is one output SLOT carrying ONE representative jobAssetId.
// For a slot holding three split documents it can only ever correct the
// representative — the other two keep their old names. That is precisely the
// shape of a file-name collision (three documents, one name), so the sweep
// cannot repair the case it most needs to.
//
// Why not just regenerate. A regenerated output comes back PENDING_REVIEW and
// has to be approved again. But the PDFs here are already correct — only their
// NAMES collided. Re-resolving the name against the same split row the runner
// used gives each document its own name with the bytes, the approval and the
// review history all untouched. The next push then writes N distinct files
// where it previously wrote one.
//
// Matching is by the split suffix carried in the variant key
// ("layout:<id>#4-5R-Mix"), which is the runner's own stable per-document
// discriminator — never by guessing from the stored name. A document whose
// split row no longer exists is SKIPPED, not renamed to something plausible.
// =====================================================

export type RestampItem = {
  jobAssetId: string;
  variantKey: string;
  from: string;
  to: string;
};

export type RestampResult = {
  scanned: number;
  changed: number;
  unchanged: number;
  skipped: number;
  dryRun: boolean;
  items: RestampItem[];
  skips: Array<{ variantKey: string; reason: string }>;
};

export async function restampFileNamesForStyle(opts: {
  styleId: string;
  // Limit to one layout (the one whose template was just fixed). Omitted =
  // every layout-backed document of the style.
  layoutId?: string;
  dryRun?: boolean;
}): Promise<RestampResult> {
  const dryRun = opts.dryRun ?? false;
  const result: RestampResult = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    dryRun,
    items: [],
    skips: [],
  };

  // Force-fresh so a template saved moments ago is the one we resolve against.
  await ensureLayoutVariantsLoaded(true);

  const ctx = await loadStyleRenderContext(opts.styleId);
  if (!ctx) {
    result.skips.push({ variantKey: "—", reason: "style render context unavailable" });
    return result;
  }

  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  const outputs = await getCurrentOutputsForStyle(opts.styleId);

  // Cache the split plan per base variant key — building it re-resolves every
  // repetition row, and a split slot asks for the same plan once per document.
  const planCache = new Map<string, Array<{ suffix: string | null; fileName: string | null }> | null>();

  for (const o of outputs) {
    if (o.jobAssetId == null || o.fileName == null) continue;
    const [baseKey, hashSuffix] = o.variantKey.split("#");
    if (!baseKey.startsWith("layout:")) continue; // framing pages have no template
    if (opts.layoutId && baseKey !== `layout:${opts.layoutId}`) continue;
    result.scanned += 1;

    let plan = planCache.get(baseKey);
    if (plan === undefined) {
      const variant = getVariant(baseKey);
      plan = variant?.filesPreview?.(ctx.styleData) ?? null;
      planCache.set(baseKey, plan);
    }
    if (!plan) {
      result.skipped += 1;
      result.skips.push({ variantKey: o.variantKey, reason: "layout variant not loaded (unpublished?)" });
      continue;
    }

    // Non-split layout: one document for the whole style.
    let target: string | null | undefined;
    if (plan.length === 1 && plan[0].suffix === null) {
      target = plan[0].fileName;
    } else if (hashSuffix) {
      const hit = plan.find((p) => p.suffix != null && p.suffix.toLowerCase() === hashSuffix.toLowerCase());
      if (!hit) {
        result.skipped += 1;
        result.skips.push({
          variantKey: o.variantKey,
          reason: `split row “${hashSuffix}” no longer exists — re-run this output`,
        });
        continue;
      }
      target = hit.fileName;
    } else {
      // A split layout whose asset carries no suffix: the runner collapsed the
      // split to one document. Only safe when the plan agrees it is single.
      if (plan.length !== 1) {
        result.skipped += 1;
        result.skips.push({ variantKey: o.variantKey, reason: "can't tie this document to one split row" });
        continue;
      }
      target = plan[0].fileName;
    }

    if (!target) {
      // Empty template — the runner default applies and already carries the
      // suffix, so there is nothing to correct.
      result.unchanged += 1;
      continue;
    }
    if (target === o.fileName) {
      result.unchanged += 1;
      continue;
    }

    result.changed += 1;
    result.items.push({ jobAssetId: o.jobAssetId, variantKey: o.variantKey, from: o.fileName, to: target });
    if (!dryRun) {
      await db.jobAsset
        .update({ where: { id: o.jobAssetId }, data: { fileName: target } })
        .catch((err) => {
          console.warn(`[restamp] could not update ${o.jobAssetId}:`, err);
        });
    }
  }

  return result;
}
