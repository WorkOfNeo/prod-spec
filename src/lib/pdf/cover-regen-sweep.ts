import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { refreshStyleCoverAsset, type CoverRefreshResult } from "@/lib/pdf/refresh-cover";
import { loadTrimSettings } from "@/lib/outputs/required-packaging";
import { enqueueCoverForSupplier, type CoverRequeueResult } from "@/lib/publish/requeue-cover";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";

// =====================================================
// "Regenerate cover pages" sweep (Settings → Cover page). Rebuilds the CURRENT
// cover of every style that already has one, so a new cover format or an edited
// global cover block reaches existing (incl. already-approved) styles without a
// full re-run. Cover-only: no output re-render, no re-review.
//
// Runs chunked + client-driven (the browser prepares the id list, then POSTs
// bounded chunks and shows progress) so each request stays inside the route's
// maxDuration and the admin can watch / stop it. Every step is idempotent, so a
// re-run — or resuming after a closed tab — is safe.
// =====================================================

export type CoverSweepStyleOutcome = CoverRefreshResult & {
  // Present when deliver was requested and the cover was refreshed: whether the
  // supplier queue row was re-armed for the SharePoint push + nightly digest.
  requeue?: CoverRequeueResult;
};

export type CoverSweepChunkResult = {
  outcomes: CoverSweepStyleOutcome[];
  // Best-effort SharePoint push summary for this chunk's re-armed covers.
  pushed: number;
  pushErrors: number;
};

// Every style with a current (newest non-FAILED job) cover — the full sweep
// target set. Distinct style ids; ordering is stable (ascending id) so
// client-driven chunking covers the set exactly once.
//
// `prodSpecId` narrows the sweep to one Customer × Business Area. That's the
// natural blast radius for a General-information edit: generalInfoMd lives on
// the ProdSpec and prints inside the covers of that spec's styles only, so
// re-rendering the whole estate for it would be pointless churn (and would
// re-push unrelated suppliers). Scoped through the STYLE's current prodSpecId,
// not the Job's: the cover renderer reads style.prodSpec, so the style's
// present-day spec is what decides whose text a refreshed cover picks up — a
// style re-pointed since its last job follows its new spec.
export async function listCoverRefreshableStyleIds(
  opts: { prodSpecId?: string } = {},
): Promise<string[]> {
  const rows = await db.job.findMany({
    where: {
      status: { not: "FAILED" },
      assets: { some: { variantKey: COVER_VARIANT_KEY } },
      ...(opts.prodSpecId ? { style: { prodSpecId: opts.prodSpecId } } : {}),
    },
    select: { styleId: true },
    distinct: ["styleId"],
    orderBy: { styleId: "asc" },
  });
  return rows.map((r) => r.styleId);
}

// Preview counts for the confirm dialog: (an upper bound on) how many of the
// given styles are delivered to a supplier and would be re-pushed + re-notified.
// Counts APPROVED styles with a linked supplier that clear the supplier-send PO
// cutoff; the per-style requeue re-checks skipSupplierDelivery, so the real
// count can be a touch lower — surfaced as "up to N". Takes the already-listed
// ids so `prepare` runs the distinct-style query only once.
//
// The cutoff belongs in this count, not just in the requeue: this number is what
// the admin reads before pressing go, and before the 2026-08-13 incident it
// silently included every old order in the book.
export async function countDeliveredAmong(styleIds: string[]): Promise<number> {
  if (styleIds.length === 0) return 0;
  const { getSupplierSendMinPo } = await import("@/lib/settings/app-settings");
  const { deliverablePoWhere } = await import("@/lib/publish/supplier-send-cutoff");
  return db.style.count({
    where: {
      id: { in: styleIds },
      status: "APPROVED",
      supplierId: { not: null },
      ...deliverablePoWhere(await getSupplierSendMinPo()),
    },
  });
}

// Process one chunk. Refreshes each style's cover; when `deliver` is set, a
// refreshed cover of a delivered style is re-armed in the supplier queue and
// the chunk is pushed to SharePoint at the end (best-effort — a push hiccup
// never fails the refresh; the recurring sweep retries, and the nightly digest
// still carries the re-armed row).
export async function processCoverRefreshChunk(
  styleIds: string[],
  opts: {
    deliver: boolean;
    onlyPending?: boolean;
    // Rebuild only covers whose printed manifest actually differs from the one
    // they carry. The filter that bounds a sweep now that Monday's trims are on
    // the manifest — see refreshStyleCoverAsset.
    onlyChanged?: boolean;
    // false ⇒ push the refreshed covers to SharePoint but keep them out of the
    // nightly digest. Only meaningful alongside deliver.
    notifySupplier?: boolean;
  },
): Promise<CoverSweepChunkResult> {
  const outcomes: CoverSweepStyleOutcome[] = [];
  const requeuedStyleIds: string[] = [];
  // Three AppSetting reads that are the same for every style in the chunk.
  const trimSettings = await loadTrimSettings();

  for (const styleId of styleIds) {
    const result = await refreshStyleCoverAsset(styleId, {
      onlyWhenPending: opts.onlyPending,
      onlyWhenChanged: opts.onlyChanged,
      trimSettings,
    });
    if (opts.deliver && result.status === "refreshed") {
      try {
        const requeue = await enqueueCoverForSupplier(styleId, result.coverAssetId, {
          notifySupplier: opts.notifySupplier,
        });
        if (requeue === "queued") requeuedStyleIds.push(styleId);
        outcomes.push({ ...result, requeue });
      } catch (err) {
        // Re-arm failure is non-fatal: the cover is refreshed in place; log via
        // the outcome so the summary can surface it, but don't drop the style.
        outcomes.push({ ...result, requeue: "not-delivered" });
        console.warn(`[cover-regen] requeue failed for ${styleId}:`, err);
      }
    } else {
      outcomes.push(result);
    }
  }

  let pushed = 0;
  let pushErrors = 0;
  if (opts.deliver && requeuedStyleIds.length > 0) {
    try {
      // Reuse the exact path publish uses — respects the supplier-send gates
      // (master switch / cutoff) and the 3-strike float. Pushes the re-armed
      // covers to each supplier's "APPROVED LAYOUTS" folder now, rather than
      // waiting for the recurring sweep. Returns EMPTY_SWEEP (0 uploaded) when
      // supplier batch-send is disabled — the re-armed rows still ride the
      // nightly digest once it's on.
      const sweep = await pushQueuedSupplierUploads({ styleIds: requeuedStyleIds, recordRunAs: "cover-regen" });
      pushed = sweep.uploaded;
      pushErrors = sweep.failed;
    } catch (err) {
      pushErrors = requeuedStyleIds.length;
      console.warn(`[cover-regen] SharePoint push failed for chunk:`, err);
    }
  }

  return { outcomes, pushed, pushErrors };
}
