import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import type { BundleDocSummary } from "@/lib/pdf/bundle-page-keys";
import { buildRequiredPackagingForStyle, loadTrimSettings } from "@/lib/outputs/required-packaging";
import { manifestFingerprint } from "@/lib/trims/manifest";
import type { TrimContext } from "@/lib/trims/style-trims";

// =====================================================
// "Show me what changes before I change it."
//
// A cover regen overwrites a file in a supplier's folder, so the honest order
// of operations is: see the diff, pick the styles, then run. This computes both
// halves of that diff through the REAL manifest builder — the same
// buildRequiredPackagingForStyle the runner and publish call, with every
// doc-type rule, reviewer ignore and info-area size applied — because a preview
// assembled by a parallel code path is a preview of something else.
//
// Two comparisons, and they answer different questions:
//
//   * `before` / `after` — the manifest WITHOUT Monday's trims folded in
//     against the one with them. This is what a person needs to look at: it
//     shows the rows this change adds to that particular cover.
//   * `storedKey` vs the fingerprint of `after` — whether the cover PDF sitting
//     in the folder right now is already current. This is what decides whether
//     the style needs regenerating at all, and it is the one the sweep gates
//     on, so a second pass over the same styles is free.
//
// The two can disagree, and that is deliberate. A cover generated after this
// shipped already carries its trims: `before` differs from `after` (the feature
// does add rows) while the stored key matches (the file is fine). Such a style
// is reported as changed:false, so a sweep does not rebuild the whole estate a
// second time.
// =====================================================

export type ManifestDiff = {
  styleId: string;
  styleName: string;
  customerName: string | null;
  poNumber: string | null;
  // The cover PDF in the folder is out of date with what we would print now.
  changed: boolean;
  // The manifest as it reads without Monday's trims — i.e. what covers printed
  // before this change.
  before: BundleDocSummary[];
  after: BundleDocSummary[];
  // Convenience counts for a list row, so the client needn't diff arrays.
  addedRows: number;
};

export type ManifestDiffChunk = {
  diffs: ManifestDiff[];
  changedCount: number;
};

// The target set (listCoverStyleIdSet) lives in cover-style-ids.ts, shared with
// the sweep so a preview and the run that follows it cannot describe different
// populations — including once the PO cutoff narrows them.

// Diff one bounded chunk. Trim settings are loaded once for the chunk (three
// AppSetting reads that are identical for every style in it).
export async function diffCoverManifests(
  styleIds: string[],
  opts?: { trimSettings?: Omit<TrimContext, "trimLabels" | "manualDelivered"> },
): Promise<ManifestDiffChunk> {
  if (styleIds.length === 0) return { diffs: [], changedCount: 0 };
  const trimSettings = opts?.trimSettings ?? (await loadTrimSettings());

  const styles = await db.style.findMany({
    where: { id: { in: styleIds } },
    select: {
      id: true,
      name: true,
      poNumber: true,
      customer: { select: { name: true } },
    },
  });
  const byId = new Map(styles.map((s) => [s.id, s]));

  // The fingerprint each cover was actually built with. Null for anything
  // generated before this shipped, which correctly reads as "unknown".
  // Guarded like the sharePointError stamp next door: coverManifestKey is an
  // additive column, and a read before its migration has run must degrade to
  // "no cover has a known fingerprint" rather than fail the whole preview. That
  // is the honest answer anyway — every cover then reads as needing one rebuild.
  const storedKeyByStyle = new Map<string, string | null>();
  try {
    const covers = await db.jobAsset.findMany({
      where: {
        variantKey: COVER_VARIANT_KEY,
        job: { styleId: { in: styleIds }, status: { not: "FAILED" } },
      },
      select: { coverManifestKey: true, job: { select: { styleId: true, createdAt: true } } },
      orderBy: { job: { createdAt: "desc" } },
    });
    for (const c of covers) {
      // Newest job first, so the first one seen per style is the current cover.
      if (!storedKeyByStyle.has(c.job.styleId)) {
        storedKeyByStyle.set(c.job.styleId, c.coverManifestKey);
      }
    }
  } catch (err) {
    console.warn("[cover-diff] coverManifestKey unavailable (migration pending?):", err);
  }

  const diffs: ManifestDiff[] = [];
  for (const styleId of styleIds) {
    const style = byId.get(styleId);
    if (!style) continue;
    try {
      const [before, after] = await Promise.all([
        buildRequiredPackagingForStyle(styleId, { withoutTrims: true }),
        // forceTrims: the preview exists to show what turning the master
        // switch ON would do, so it must not be gated by that switch. This is
        // the ONE caller allowed to bypass it — nothing here writes a PDF.
        buildRequiredPackagingForStyle(styleId, { trimSettings, forceTrims: true }),
      ]);
      const storedKey = storedKeyByStyle.get(styleId) ?? null;
      const afterKey = manifestFingerprint(after);
      diffs.push({
        styleId,
        styleName: style.name,
        customerName: style.customer?.name ?? null,
        poNumber: style.poNumber,
        // A cover with no stored key predates the fingerprint, so we cannot
        // claim it is current — rebuild it once, then it stamps its own key and
        // stops appearing here.
        changed: storedKey === null || storedKey !== afterKey,
        before,
        after,
        addedRows: Math.max(0, after.length - before.length),
      });
    } catch (err) {
      // One unreadable style must not abort a chunk of twenty-five. It simply
      // doesn't appear in the preview, and the sweep will report its error.
      console.warn(`[cover-diff] ${styleId} failed:`, err);
    }
  }

  return { diffs, changedCount: diffs.filter((d) => d.changed).length };
}
