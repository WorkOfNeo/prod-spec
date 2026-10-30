import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { getGenerationMinPo } from "@/lib/settings/app-settings";
import { partitionByGenerationCutoff } from "@/lib/queue/generation-cutoff";

// =====================================================
// Which styles a cover sweep — or its preview — is about.
//
// This lived in two places: listCoverRefreshableStyleIds (cover-regen-sweep)
// and listCoverStyleIds (cover-manifest-diff), byte-identical, with a comment on
// the second saying it must stay that way so "a preview and the run that follows
// it cannot describe different populations". Adding the PO cutoff to two copies
// of one query is how that comment stops being true, so the query lives here now
// and both call it.
//
// THE CUTOFF. The sweep is a bulk generation lane, so it takes the GENERATION
// cutoff (generationMinPo) like every other one — /styles bulk-regen, the
// prod-spec Run lanes — including their NULL-poSeq rule: a style whose PO never
// parsed is IN scope, because an unparseable PO is not an old one. Measured when
// this landed: 1,401 of 1,919 cover-holding styles sat below the cutoff, so the
// sweep spent three quarters of its Chromium time rebuilding covers that
// enqueueCoverForSupplier then refused to push ("below-cutoff"). Nothing
// downstream changes: delivery is still gated separately on supplierSendMinPo,
// whose NULL rule is deliberately the opposite. Two questions, two predicates —
// see src/lib/queue/generation-cutoff.ts for why they must not be merged.
//
// Not a hard gate. Same call as the other bulk lanes (2026-08-13, "show it,
// don't block it"): default to the in-scope set, report what was parked, and let
// the operator opt the rest back in.
// =====================================================

export type CoverStyleIdSet = {
  // The styles a run will actually touch.
  styleIds: string[];
  // How many cover-holding styles were left out for sitting below the cutoff.
  // Zero when the caller asked for them, or when no cutoff is configured.
  skippedBelowCutoff: number;
  // The cutoff applied, so the UI can name it ("PO ≥ 63320") rather than
  // re-reading the setting and risking a different answer.
  cutoff: number | null;
};

// Every style holding a current (newest non-FAILED job) cover, minus the ones
// parked below the generation cutoff. Ordering is stable (ascending id) so
// client-driven chunking covers the set exactly once.
//
// `prodSpecId` narrows to one Customer × Business Area — the blast radius of a
// General-information edit, since generalInfoMd lives on the ProdSpec and prints
// only inside its own styles' covers. Scoped through the STYLE's current
// prodSpecId, not the Job's: the cover renderer reads style.prodSpec, so the
// style's present-day spec decides whose text a refreshed cover picks up.
export async function listCoverStyleIdSet(
  opts: { prodSpecId?: string; includeBelowCutoff?: boolean } = {},
): Promise<CoverStyleIdSet> {
  const rows = await db.job.findMany({
    where: {
      status: { not: "FAILED" },
      assets: { some: { variantKey: COVER_VARIANT_KEY } },
      ...(opts.prodSpecId ? { style: { prodSpecId: opts.prodSpecId } } : {}),
    },
    // poSeq rides along so the partition and the count come from ONE query —
    // the alternative is a second pass whose answer can drift from the first.
    select: { styleId: true, style: { select: { poSeq: true } } },
    distinct: ["styleId"],
    orderBy: { styleId: "asc" },
  });

  const all = rows.map((r) => ({ styleId: r.styleId, poSeq: r.style?.poSeq ?? null }));

  if (opts.includeBelowCutoff) {
    // Deliberately still reports cutoff: the UI says "including N below PO ≥ X",
    // which needs the number even on the run that ignores it.
    return {
      styleIds: all.map((r) => r.styleId),
      skippedBelowCutoff: 0,
      cutoff: await getGenerationMinPo(),
    };
  }

  const cutoff = await getGenerationMinPo();
  const { inScope, belowCutoff } = partitionByGenerationCutoff(all, cutoff);
  return {
    styleIds: inScope.map((r) => r.styleId),
    skippedBelowCutoff: belowCutoff.length,
    cutoff,
  };
}
