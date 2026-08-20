import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { resolveCurrentFileNames, type NameableDocument } from "./current-file-names";

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
// The resolution itself lives in current-file-names.ts, shared with the folder
// reconcile so "what should this be called?" has exactly one answer in the app.
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
  // Done here rather than inside the resolver so the render-context failure
  // below can be reported as its own skip.
  await ensureLayoutVariantsLoaded(true);

  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  const outputs = await getCurrentOutputsForStyle(opts.styleId);

  // General-info framing pages have no template, and a layout filter narrows to
  // one layout. Both are decided BEFORE `scanned` is counted so the tally keeps
  // meaning "documents this restamp actually considered".
  //
  // The COVER is included in an un-filtered restamp: it is named by the bundle
  // rule rather than a layout template, but that rule now carries the style's
  // colour, so a cover generated before the colour existed is exactly as stale
  // as a layout document whose template moved. A layoutId-scoped restamp still
  // skips it — that caller is repairing one layout, not the bundle.
  const considered = outputs.filter((o) => {
    if (o.jobAssetId == null || o.fileName == null) return false;
    const baseKey = o.variantKey.split("#")[0];
    if (baseKey === COVER_VARIANT_KEY) return !opts.layoutId;
    if (!baseKey.startsWith("layout:")) return false;
    if (opts.layoutId && baseKey !== `layout:${opts.layoutId}`) return false;
    return true;
  });
  result.scanned = considered.length;

  const docs: NameableDocument[] = considered.map((o) => ({
    jobAssetId: o.jobAssetId as string,
    variantKey: o.variantKey,
  }));
  const names = await resolveCurrentFileNames(opts.styleId, docs, { variantsAlreadyFresh: true });

  if (names.size === 0 && considered.length > 0) {
    result.skips.push({ variantKey: "—", reason: "style render context unavailable" });
    result.skipped = considered.length;
    return result;
  }

  for (const o of considered) {
    const jobAssetId = o.jobAssetId as string;
    const resolution = names.get(jobAssetId);

    if (!resolution || resolution.kind === "unresolvable") {
      result.skipped += 1;
      result.skips.push({
        variantKey: o.variantKey,
        reason: resolution?.kind === "unresolvable" ? resolution.reason : "no current name could be resolved",
      });
      continue;
    }
    // "template-default" (empty template — the runner default already carries
    // the suffix) and "no-template" both mean the stored name is correct.
    if (resolution.kind !== "resolved" || resolution.fileName === o.fileName) {
      result.unchanged += 1;
      continue;
    }

    result.changed += 1;
    result.items.push({
      jobAssetId,
      variantKey: o.variantKey,
      from: o.fileName as string,
      to: resolution.fileName,
    });
    if (!dryRun) {
      await db.jobAsset
        .update({ where: { id: jobAssetId }, data: { fileName: resolution.fileName } })
        .catch((err) => {
          console.warn(`[restamp] could not update ${jobAssetId}:`, err);
        });
    }
  }

  return result;
}
