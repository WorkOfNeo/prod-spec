import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { approvedOutputBaseKeysForStyle } from "@/lib/outputs/current-outputs";
import { buildStyleCoverPdf } from "@/lib/pdf/style-cover";
import { toPlainBytes } from "@/lib/pdf/bytes";

// =====================================================
// Refresh a style's CURRENT cover asset in place — cover-only, no output
// regeneration and no re-review. This is what the "Regenerate cover pages"
// sweep (Settings → Cover page) runs so an already-approved / delivered style
// picks up a new cover format or an edited global cover block WITHOUT going
// through a full generation run.
//
// Why a dedicated path: the runner only (re)renders the cover when a run
// actually generates ≥1 output, and a fully-approved style short-circuits
// before the cover step (runner "all outputs already approved → settle without
// rendering"). Publish re-renders the cover, but only when a job is freshly
// approved. So existing approved covers are otherwise frozen on their
// generation-time format. This overwrites the bytes of the SAME asset the
// review page / supplier push already treat as current (newest non-FAILED
// job's cover), so the fresh cover flows everywhere the old one did with no
// status change.
// =====================================================

export type CoverRefreshResult =
  | { styleId: string; status: "refreshed"; coverAssetId: string; jobId: string }
  // No cover asset exists yet (style never generated a bundle) — nothing to
  // refresh; it'll get the current format when it's first generated.
  | { styleId: string; status: "no-cover" }
  | { styleId: string; status: "error"; error: string };

// The asset the review surfaces + supplier push treat as the style's current
// cover: the newest non-FAILED job's COVER page. selectCurrentAssets picks the
// same one (newest job per base), so overwriting THIS asset's bytes is what
// makes the refreshed cover current everywhere.
export async function getCurrentCoverAsset(
  styleId: string,
): Promise<{ id: string; jobId: string } | null> {
  const asset = await db.jobAsset.findFirst({
    where: {
      variantKey: COVER_VARIANT_KEY,
      job: { styleId, status: { not: "FAILED" } },
    },
    orderBy: { job: { createdAt: "desc" } },
    select: { id: true, jobId: true },
  });
  return asset ? { id: asset.id, jobId: asset.jobId } : null;
}

// Rebuild + overwrite a style's current cover PDF from live state. The approval
// flags are read live (approvedOutputBaseKeysForStyle) — the assets are already
// persisted, so no projection is needed (unlike publish, which renders while
// this job's outputs are mid-approval). reviewStatus is left untouched: an
// approved cover stays approved, so the supplier share link + SharePoint push
// serve the new bytes without re-review.
export async function refreshStyleCoverAsset(styleId: string): Promise<CoverRefreshResult> {
  const cover = await getCurrentCoverAsset(styleId);
  if (!cover) return { styleId, status: "no-cover" };

  try {
    const approvedBases = await approvedOutputBaseKeysForStyle(styleId);
    const pdf = await buildStyleCoverPdf(cover.jobId, approvedBases);
    if (!pdf) {
      return { styleId, status: "error", error: "cover render returned null (job/style unloadable)" };
    }
    await db.jobAsset.update({ where: { id: cover.id }, data: { pdf: toPlainBytes(pdf) } });
    return { styleId, status: "refreshed", coverAssetId: cover.id, jobId: cover.jobId };
  } catch (err) {
    return { styleId, status: "error", error: (err as Error).message };
  }
}
