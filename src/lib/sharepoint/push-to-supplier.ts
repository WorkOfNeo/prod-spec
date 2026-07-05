import { db } from "@/lib/db";
import {
  resolveSupplierFolder,
  ensureChildFolder,
  uploadIntoFolder,
  sanitizeName,
  SharePointWriteForbiddenError,
} from "./supplier-folder";

// =====================================================
// Push approved output PDFs into the supplier's own SharePoint folder, under a
// single "<style> – <customer>" subfolder. Manual, admin-triggered (phase 1) —
// distinct from the auto publish-on-approval upload in publish-approved-job.ts,
// which targets the configured SHAREPOINT_SITE_ID site. Only APPROVED,
// print-safe (no-placeholder) assets are ever pushed.
// =====================================================

export class SupplierPushError extends Error {
  constructor(
    public readonly httpStatus: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SupplierPushError";
  }
}

export type PushedFile = { assetId: string; fileName: string; webUrl: string | null };

export type SupplierPushResult = {
  dryRun: boolean;
  supplierName: string;
  folderName: string; // the "<style> – <customer>" subfolder name
  supplierFolderUrl: string | null; // the supplier's root folder
  targetFolderUrl: string | null; // the subfolder (null on dry run)
  pushed: PushedFile[];
  skipped: Array<{ assetId: string; fileName: string; reason: string }>;
};

export async function pushApprovedAssetsToSupplier(input: {
  styleId: string;
  assetIds: string[];
  dryRun?: boolean;
  userId?: string;
}): Promise<SupplierPushResult> {
  const dryRun = input.dryRun ?? false;

  const style = await db.style.findUnique({
    where: { id: input.styleId },
    select: {
      id: true,
      name: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  if (!style) throw new SupplierPushError(404, "Style not found");

  const supplier = style.supplier;
  if (!supplier) {
    throw new SupplierPushError(
      409,
      "This style has no linked supplier — set the supplier on the Monday Pre-Order board and re-sync before pushing.",
    );
  }
  const sharingUrl = supplier.sharepointUrl?.trim();
  if (!sharingUrl) {
    throw new SupplierPushError(
      409,
      `No SharePoint folder on file for supplier “${supplier.name}” — set the Supplier Folder link on the Monday Suppliers board and re-sync.`,
    );
  }

  if (input.assetIds.length === 0) {
    throw new SupplierPushError(400, "No outputs selected to push.");
  }

  // Load the named assets, scoped to THIS style so an id from another style
  // can't be smuggled through. pdf is the raw bytes stored at generation time.
  const assets = await db.jobAsset.findMany({
    where: { id: { in: input.assetIds }, job: { styleId: style.id } },
    select: {
      id: true,
      jobId: true,
      fileName: true,
      reviewStatus: true,
      placeholderCount: true,
      pdf: true,
    },
  });

  // Gate (defense-in-depth — the UI already restricts to approved): only
  // APPROVED, print-safe (no-placeholder) outputs reach the supplier.
  const pushable = assets.filter((a) => a.reviewStatus === "APPROVED" && a.placeholderCount === 0);
  const skipped = assets
    .filter((a) => !(a.reviewStatus === "APPROVED" && a.placeholderCount === 0))
    .map((a) => ({
      assetId: a.id,
      fileName: a.fileName,
      reason: a.placeholderCount > 0 ? "contains placeholders" : `not approved (${a.reviewStatus.toLowerCase()})`,
    }));

  if (pushable.length === 0) {
    throw new SupplierPushError(
      409,
      "None of the selected outputs are approved & print-safe — approve them first.",
    );
  }

  const folderName = sanitizeName(`${style.name} – ${style.customer.name}`);

  // Resolve the supplier's folder (read — works before write is granted).
  let folder;
  try {
    folder = await resolveSupplierFolder(sharingUrl);
  } catch (err) {
    throw new SupplierPushError(
      409,
      `Could not open supplier “${supplier.name}” SharePoint folder — ${(err as Error).message}.`,
    );
  }

  // Dry run: report the resolved target + file list without writing anything.
  if (dryRun) {
    return {
      dryRun: true,
      supplierName: supplier.name,
      folderName,
      supplierFolderUrl: folder.webUrl,
      targetFolderUrl: null,
      pushed: pushable.map((a) => ({ assetId: a.id, fileName: a.fileName, webUrl: null })),
      skipped,
    };
  }

  // Ensure the "<style> – <customer>" subfolder once, then upload each PDF.
  let subfolder;
  try {
    subfolder = await ensureChildFolder(folder.driveId, folder.itemId, folderName);
  } catch (err) {
    throw toPushError(err);
  }

  const pushed: PushedFile[] = [];
  for (const a of pushable) {
    try {
      const up = await uploadIntoFolder(folder.driveId, subfolder.id, a.fileName, Buffer.from(a.pdf));
      pushed.push({ assetId: a.id, fileName: up.name, webUrl: up.webUrl });
    } catch (err) {
      throw toPushError(err);
    }
  }

  // Remember the style's supplier-folder location (WS3) — the nightly digest
  // links it so the supplier lands directly on their files. Best-effort; a
  // failed write here must not fail a push that already succeeded.
  if (subfolder.webUrl) {
    await db.style
      .update({ where: { id: style.id }, data: { supplierFolderUrl: subfolder.webUrl } })
      .catch(() => {});
  }

  // Audit: one log line against the asset's job so it shows in the style's
  // activity feed alongside generation/approval/publish events.
  await db.log.create({
    data: {
      jobId: pushable[0]?.jobId ?? null,
      level: "INFO",
      message:
        `pushed ${pushed.length} output(s) to supplier folder · ${supplier.name} → ${folderName}` +
        (subfolder.webUrl ? ` · ${subfolder.webUrl}` : ""),
      payload: { supplier: supplier.name, folderName, pushed, skipped, byUserId: input.userId ?? null },
    },
  });

  return {
    dryRun: false,
    supplierName: supplier.name,
    folderName,
    supplierFolderUrl: folder.webUrl,
    targetFolderUrl: subfolder.webUrl,
    pushed,
    skipped,
  };
}

// Map a SharePoint write 403 to a clear "ask FLC" message; rethrow anything
// else as-is for the route's generic 500 handler.
function toPushError(err: unknown): unknown {
  if (err instanceof SharePointWriteForbiddenError) {
    return new SupplierPushError(403, `${err.message}. Ask FLC to enable write on Contrast-Suppliers, then retry.`);
  }
  return err;
}
