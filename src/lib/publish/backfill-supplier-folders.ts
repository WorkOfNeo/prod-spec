import { db } from "@/lib/db";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "@/lib/sharepoint/push-to-supplier";
import { getCurrentOutputsForStyle } from "@/lib/outputs/current-outputs";
import { parseCustomerConfig } from "@/lib/customers/config";

// =====================================================
// One-off backfill: re-push already-delivered styles into the NEW supplier-
// folder naming ("<PO> - <customer> - <supplier> - APPROVED LAYOUTS", see
// push-to-supplier.ts). The folder-name change is forward-only — a style whose
// approved layouts already sit in an old "<style> – <customer>" folder would
// otherwise have its FUTURE approvals land in the new folder, splitting the set
// across two folders. This walks every style that was previously pushed
// (Style.supplierFolderUrl set) and re-pushes its CURRENT approved + print-safe
// outputs into the new-named folder, consolidating the set. Idempotent: uploads
// PUT-overwrite by filename and the subfolder is get-or-create, so re-running is
// safe.
//
// SCOPE (deliberately narrow — Niels's call): only styles with a stored
// supplierFolderUrl, i.e. ones that were actually pushed to an old-named folder.
// Fresh styles need no backfill — their first approval already uses the new name.
//
// OLD FOLDERS ARE LEFT IN PLACE. We never delete supplier-facing SharePoint
// content from code (destructive across a system boundary, and suppliers may be
// looking at it). Instead the result carries a `cleanup` list of the old folder
// URLs so an operator can remove them by hand once the new ones are verified.
//
// Runs through pushApprovedAssetsToSupplier — the MANUAL push path — so it works
// regardless of the "Automatic supplier sending" master toggle, exactly like the
// per-style / per-asset "Push to supplier" buttons. Fail-soft per style: one
// style's SharePoint error never aborts the sweep.
// =====================================================

export type BackfillStyleStatus = "REPUSHED" | "SKIPPED" | "FAILED";

export type BackfillStyleResult = {
  styleId: string;
  styleName: string;
  poNumber: string | null;
  supplierName: string | null;
  status: BackfillStyleStatus;
  pushed: number; // documents (re)uploaded into the new folder
  oldFolderUrl: string | null; // the previous "<style> – <customer>" folder (to clean up)
  newFolderUrl: string | null; // the new-named folder (null on dry run / skip / fail)
  folderName: string | null; // the resolved new folder name (dry run + apply)
  note: string;
};

export type BackfillResult = {
  dryRun: boolean;
  candidates: number;
  repushed: number;
  skipped: number;
  failed: number;
  results: BackfillStyleResult[];
  // Old folders now superseded by a new-named one — surfaced for MANUAL deletion.
  cleanup: Array<{ styleName: string; oldFolderUrl: string }>;
};

export async function backfillSupplierFolders(opts?: {
  dryRun?: boolean;
  // Restrict to specific styles (else every already-pushed style).
  styleIds?: string[];
  userId?: string;
}): Promise<BackfillResult> {
  const dryRun = opts?.dryRun ?? false;

  // Scope: styles previously pushed to an OLD-named folder → supplierFolderUrl set.
  const styles = await db.style.findMany({
    where: {
      supplierFolderUrl: { not: null },
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { id: { in: opts.styleIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      poNumber: true,
      supplierFolderUrl: true,
      supplier: { select: { name: true, sharepointUrl: true } },
      customer: { select: { config: true } },
    },
    orderBy: { name: "asc" },
  });

  const results: BackfillStyleResult[] = [];
  let repushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const style of styles) {
    const base: BackfillStyleResult = {
      styleId: style.id,
      styleName: style.name,
      poNumber: style.poNumber,
      supplierName: style.supplier?.name ?? null,
      status: "SKIPPED",
      pushed: 0,
      oldFolderUrl: style.supplierFolderUrl,
      newFolderUrl: null,
      folderName: null,
      note: "",
    };
    const record = (r: Partial<BackfillStyleResult> & { status: BackfillStyleStatus; note: string }) => {
      const full = { ...base, ...r };
      results.push(full);
      if (full.status === "REPUSHED") repushed += 1;
      else if (full.status === "FAILED") failed += 1;
      else skipped += 1;
    };

    // Mirror the push gates so we skip cleanly instead of throwing.
    if (parseCustomerConfig(style.customer.config).skipSupplierDelivery) {
      record({ status: "SKIPPED", note: "customer delivers own (skipSupplierDelivery)" });
      continue;
    }
    if (!style.supplier?.sharepointUrl?.trim()) {
      record({ status: "SKIPPED", note: "supplier has no folder link" });
      continue;
    }

    // The style's CURRENT approved + print-safe outputs (same selection the
    // review screen and the nightly sweep use).
    let assetIds: string[];
    try {
      const outputs = await getCurrentOutputsForStyle(style.id);
      assetIds = [
        ...new Set(
          outputs
            .filter((o) => o.jobAssetId && o.reviewStatus === "APPROVED" && o.placeholderCount === 0)
            .map((o) => o.jobAssetId as string),
        ),
      ];
    } catch (err) {
      record({ status: "FAILED", note: `could not resolve current outputs — ${(err as Error).message}` });
      continue;
    }
    if (assetIds.length === 0) {
      record({ status: "SKIPPED", note: "no approved, print-safe outputs currently" });
      continue;
    }

    try {
      const res = await pushApprovedAssetsToSupplier({
        styleId: style.id,
        assetIds,
        dryRun,
        userId: opts?.userId,
      });
      record({
        status: "REPUSHED",
        pushed: res.pushed.length,
        newFolderUrl: res.targetFolderUrl,
        folderName: res.folderName,
        note: dryRun
          ? `would push ${res.pushed.length} document(s) → "${res.folderName}"`
          : `pushed ${res.pushed.length} document(s) → "${res.folderName}"`,
      });
    } catch (err) {
      // A SupplierPushError that isn't a 403 is a data-shaped gap (no pushable
      // asset, folder unresolvable) → SKIPPED. 403 (write not granted) and
      // anything unexpected are real failures worth surfacing → FAILED.
      const dataGap = err instanceof SupplierPushError && err.httpStatus !== 403;
      record({
        status: dataGap ? "SKIPPED" : "FAILED",
        note: (err as Error).message,
      });
    }
  }

  // Old folders that a new-named folder now supersedes — for manual cleanup.
  // (Only on a real run, where the new folder actually exists.)
  const cleanup = results
    .filter(
      (r) =>
        r.status === "REPUSHED" &&
        r.newFolderUrl != null && // real (apply) run resolved a new folder
        r.oldFolderUrl != null &&
        r.oldFolderUrl !== r.newFolderUrl,
    )
    .map((r) => ({ styleName: r.styleName, oldFolderUrl: r.oldFolderUrl as string }));

  return { dryRun, candidates: styles.length, repushed, skipped, failed, results, cleanup };
}
