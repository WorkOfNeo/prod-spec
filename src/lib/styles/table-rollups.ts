import { db } from "@/lib/db";
import { selectCurrentAssets, approvedBaseVariantKeys } from "@/lib/outputs/current-outputs";

// =====================================================
// Batched rollups for the /styles table's opt-in columns. Both are ONE query
// for the whole page (never per-row), and page.tsx only calls them when a
// column that needs them is visible (needsSupplierUploadData /
// needsReviewRollupData). Everything degrades to an empty map on error so the
// styles list never 500s over an optional column.
// =====================================================

// ── SharePoint upload rollup (delivery group) ────────────────────────────────
export type SupplierUploadRollup = {
  uploaded: number;
  total: number;
  noFolder: number;
  ambiguous: number;
  failed: number;
  skipped: number;
  pending: number;
};

// Per-style counts of supplier-send queue rows by SharePoint status — the same
// signal /settings/approved and the single-style "Supplier folder" panel show,
// collapsed to a table cell. One groupBy for every style on the page.
export async function loadSupplierUploadRollups(
  styleIds: string[],
): Promise<Map<string, SupplierUploadRollup>> {
  const out = new Map<string, SupplierUploadRollup>();
  if (styleIds.length === 0) return out;
  try {
    const rows = await db.supplierSendQueueItem.groupBy({
      by: ["styleId", "sharePointStatus"],
      where: { styleId: { in: styleIds } },
      _count: { _all: true },
    });
    for (const r of rows) {
      const cur =
        out.get(r.styleId) ??
        { uploaded: 0, total: 0, noFolder: 0, ambiguous: 0, failed: 0, skipped: 0, pending: 0 };
      const n = r._count._all;
      cur.total += n;
      switch (r.sharePointStatus) {
        case "UPLOADED":
          cur.uploaded += n;
          break;
        case "NO_FOLDER":
          cur.noFolder += n;
          break;
        case "AMBIGUOUS":
          cur.ambiguous += n;
          break;
        case "FAILED":
          cur.failed += n;
          break;
        case "SKIPPED":
          cur.skipped += n;
          break;
        default:
          cur.pending += n; // PENDING (or any future status) reads as in-flight
          break;
      }
      out.set(r.styleId, cur);
    }
  } catch {
    return new Map();
  }
  return out;
}

// ── Review / approval rollup (review group) ──────────────────────────────────
export type ReviewAsset = {
  jobId: string;
  variantKey: string | null;
  docType: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  placeholderCount: number;
};

// Every non-FAILED asset for the given styles, NEWEST JOB FIRST, grouped by
// style — one query. Metadata only (never the PDF Bytes column). The per-style
// arrays keep the global newest-first order, which is exactly what
// selectCurrentAssets / approvedBaseVariantKeys expect.
export async function loadAssetsByStyle(styleIds: string[]): Promise<Map<string, ReviewAsset[]>> {
  const out = new Map<string, ReviewAsset[]>();
  if (styleIds.length === 0) return out;
  try {
    const assets = await db.jobAsset.findMany({
      where: { job: { styleId: { in: styleIds }, status: { not: "FAILED" } } },
      orderBy: { job: { createdAt: "desc" } },
      select: {
        jobId: true,
        variantKey: true,
        docType: true,
        reviewStatus: true,
        placeholderCount: true,
        job: { select: { styleId: true } },
      },
    });
    for (const a of assets) {
      const sid = a.job.styleId;
      const arr = out.get(sid);
      const row: ReviewAsset = {
        jobId: a.jobId,
        variantKey: a.variantKey,
        docType: a.docType,
        reviewStatus: a.reviewStatus,
        placeholderCount: a.placeholderCount,
      };
      if (arr) arr.push(row);
      else out.set(sid, [row]);
    }
  } catch {
    return new Map();
  }
  return out;
}

export type ReviewRollup = {
  approved: number; // approved (+ print-safe) output bases
  generated: number; // output bases with a current asset
  total: number; // declared enabled (non-excluded) outputs — the denominator
  awaiting: number; // current bases with a document still pending review
  fullyApproved: boolean;
};

const baseOf = (variantKey: string | null, docType: string) =>
  (variantKey ?? `doc:${docType}`).split("#")[0];

// Pure: fold one style's assets into the review rollup, using the SAME current-
// asset selection the review page uses (selectCurrentAssets: superseded-by-
// newest-job, orphaned + excluded bases dropped). `totalDeclared` is the
// style's declared enabled (non-excluded) output count — the stable denominator
// so a partly-generated style still reads "2/5", never shrinking to what's
// generated so far.
export function reviewRollupFor(
  assets: ReviewAsset[],
  declaredBaseKeys: Set<string>,
  excludedBaseKeys: Set<string>,
  totalDeclared: number,
): ReviewRollup {
  const approvedBases = approvedBaseVariantKeys(assets, declaredBaseKeys, excludedBaseKeys);
  const current = selectCurrentAssets(assets, declaredBaseKeys, excludedBaseKeys);

  const byBase = new Map<string, ReviewAsset[]>();
  for (const a of current) {
    const b = baseOf(a.variantKey, a.docType);
    const arr = byBase.get(b);
    if (arr) arr.push(a);
    else byBase.set(b, [a]);
  }

  let awaiting = 0;
  for (const docs of byBase.values()) {
    if (docs.some((d) => d.reviewStatus === "PENDING_REVIEW")) awaiting += 1;
  }

  const generated = byBase.size;
  const approved = approvedBases.size;
  // Denominator is the declared output count, but never less than what's
  // actually generated (framing docs / legacy assets can exceed the count).
  const total = Math.max(totalDeclared, generated);
  return {
    approved,
    generated,
    total,
    awaiting,
    fullyApproved: total > 0 && approved === total,
  };
}
