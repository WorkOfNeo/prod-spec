import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { approvedOutputBaseKeysForStyle } from "@/lib/outputs/current-outputs";
import { buildRequiredPackagingForStyle, loadTrimSettings } from "@/lib/outputs/required-packaging";
import { manifestFingerprint } from "@/lib/trims/manifest";
import type { TrimContext } from "@/lib/trims/style-trims";
import { hasPendingRows } from "@/lib/pdf/bundle-pages";
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
  // Every declared output is approved, so the cover's manifest prints no status
  // wording at all — a rebuild would produce a visually identical page while
  // overwriting the supplier's copy for a finished order. Only returned when
  // the caller asks for it (onlyWhenPending).
  | { styleId: string; status: "skipped-all-approved" }
  // The manifest this cover would print is byte-identical to the one it already
  // carries, so rebuilding it would overwrite a supplier's file to change
  // nothing. Only returned when the caller asks for it (onlyWhenChanged).
  | { styleId: string; status: "skipped-unchanged" }
  | { styleId: string; status: "error"; error: string };

// The asset the review surfaces + supplier push treat as the style's current
// cover: the newest non-FAILED job's COVER page. selectCurrentAssets picks the
// same one (newest job per base), so overwriting THIS asset's bytes is what
// makes the refreshed cover current everywhere.
export async function getCurrentCoverAsset(
  styleId: string,
): Promise<{ id: string; jobId: string; coverManifestKey: string | null } | null> {
  const asset = await db.jobAsset.findFirst({
    where: {
      variantKey: COVER_VARIANT_KEY,
      job: { styleId, status: { not: "FAILED" } },
    },
    orderBy: { job: { createdAt: "desc" } },
    select: { id: true, jobId: true, coverManifestKey: true },
  });
  return asset
    ? { id: asset.id, jobId: asset.jobId, coverManifestKey: asset.coverManifestKey }
    : null;
}

// Rebuild + overwrite a style's current cover PDF from live state. The approval
// flags are read live (approvedOutputBaseKeysForStyle) — the assets are already
// persisted, so no projection is needed (unlike publish, which renders while
// this job's outputs are mid-approval). reviewStatus is left untouched: an
// approved cover stays approved, so the supplier share link + SharePoint push
// serve the new bytes without re-review.
export async function refreshStyleCoverAsset(
  styleId: string,
  opts?: {
    // Skip styles whose every declared output is approved. Their manifest
    // prints no status wording, so a rebuild is visually a no-op — but it still
    // overwrites the cover in the supplier's folder for an order that's already
    // finished. Off by default so the plain refresh path is unchanged.
    //
    // NOTE this filter lost most of its power when Monday's Trims entries
    // joined the manifest: a style that is waiting on a manually supplied
    // hangtag has a pending row even though every output we generate is
    // approved, which is true of nearly the whole estate. onlyWhenChanged is
    // the filter that actually bounds a sweep now.
    onlyWhenPending?: boolean;
    // Skip styles whose manifest already matches what it would print. This is
    // the one that makes a repeat sweep free: the first pass stamps the
    // fingerprint, and every pass after it does nothing until the manifest
    // genuinely moves.
    onlyWhenChanged?: boolean;
    // Compute and stamp the manifest fingerprint WITHOUT gating on it — for
    // callers that always want the rebuild but must not leave the ledger worse
    // than they found it. The single-style regenerate is the case: a person
    // typed that style number, so skipping the rebuild as "unchanged" would be
    // precisely the useless no-op they came here to avoid — but writing a null
    // fingerprint over a valid one would make the next bulk sweep rebuild and
    // re-push this cover for nothing. This buys the honest stamp for one extra
    // manifest build, which is negligible beside the puppeteer pass that
    // follows it unconditionally.
    stampManifest?: boolean;
    // Pre-loaded trim configuration, for callers refreshing many styles.
    trimSettings?: Omit<TrimContext, "trimLabels" | "manualDelivered">;
  },
): Promise<CoverRefreshResult> {
  const cover = await getCurrentCoverAsset(styleId);
  if (!cover) return { styleId, status: "no-cover" };

  try {
    const approvedBases = await approvedOutputBaseKeysForStyle(styleId);

    // Same manifest the render builds, resolved through the same function, so
    // the skip decision can't drift from what the page would actually show.
    // Costs a second buildRequiredPackagingForStyle for styles we DO render —
    // negligible next to the puppeteer pass it guards, and it saves that pass
    // outright for every style it skips.
    // One manifest build serves both gates AND the fingerprint we persist, so
    // the expensive part (buildRequiredPackagingForStyle) runs at most once per
    // style even when both filters are on. Negligible next to the puppeteer
    // pass it guards, and it saves that pass outright for every style it skips.
    let manifestKey: string | null = null;
    if (opts?.onlyWhenPending || opts?.onlyWhenChanged || opts?.stampManifest) {
      const trimSettings = opts.trimSettings ?? (await loadTrimSettings());
      const docs = await buildRequiredPackagingForStyle(styleId, {
        approvedBaseKeysOverride: approvedBases,
        trimSettings,
      });
      if (opts.onlyWhenPending && !hasPendingRows(docs)) {
        return { styleId, status: "skipped-all-approved" };
      }
      manifestKey = manifestFingerprint(docs);
      if (opts.onlyWhenChanged && cover.coverManifestKey === manifestKey) {
        return { styleId, status: "skipped-unchanged" };
      }
    }

    const pdf = await buildStyleCoverPdf(cover.jobId, approvedBases);
    if (!pdf) {
      return { styleId, status: "error", error: "cover render returned null (job/style unloadable)" };
    }
    await db.jobAsset.update({
      where: { id: cover.id },
      // Stamp the fingerprint alongside the bytes so the next sweep can tell
      // this cover is current. Null when neither gate ran and we therefore
      // never computed one — an honest "unknown", which reads as "rebuild once"
      // rather than as a false match.
      data: { pdf: toPlainBytes(pdf), coverManifestKey: manifestKey },
    });
    return { styleId, status: "refreshed", coverAssetId: cover.id, jobId: cover.jobId };
  } catch (err) {
    return { styleId, status: "error", error: (err as Error).message };
  }
}
