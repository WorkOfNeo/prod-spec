import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

// =====================================================
// "Should this document be sitting in the supplier's APPROVED LAYOUTS folder
// right now?" — the single answer, shared by every surface that audits that
// folder, so they cannot disagree about what belongs in it.
//
// The rule used to be spelled out inline as "approved, print-safe, has an asset
// and a file name". That is right for a layout output and WRONG for the cover,
// and the difference is not cosmetic: the cover is a framing MANIFEST whose
// delivery is deliberately decoupled from approval (see enqueueCoverForSupplier
// — it ships as soon as it exists and is re-armed on every regeneration). It
// therefore sits in the folder while its reviewStatus is still PENDING_REVIEW.
//
// Reading the approval rule literally meant every folder audit silently left
// the cover out of the expected set — so a PO whose two colourways overwrote
// each other's cover reported a clean ledger, which is exactly how a supplier
// came to receive two covers for four styles without anything noticing.
// =====================================================

export type FolderExpectable = {
  variantKey: string;
  jobAssetId: string | null;
  fileName: string | null;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | null;
  placeholderCount: number;
};

export function isExpectedInSupplierFolder(o: FolderExpectable): boolean {
  // No stored asset or no name ⇒ nothing was ever uploaded to ask about.
  if (o.jobAssetId == null || o.fileName == null) return false;
  // A placeholder-carrying render is never shipped, cover or not.
  if (o.placeholderCount > 0) return false;
  // The cover ships without an approval; everything else earns its place.
  if (o.variantKey.split("#")[0] === COVER_VARIANT_KEY) return true;
  return o.reviewStatus === "APPROVED";
}
