import { ensureFolder, uploadFile, type SharePointFile } from "./client";
import {
  deleteDriveItem,
  ensureChildFolder,
  listChildFolders,
  resolvePoFolder,
  resolveSupplierFolder,
  sanitizeFileName,
  uploadIntoFolder,
} from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";

export type UploadResult = SharePointFile & { docType: string };

// Publish-to-SITE upload (SHAREPOINT_SITE_ID). Distinct from everything below,
// which writes into the SUPPLIER's own folder via a sharing link and needs no
// site id — see the note on uploadIntoApprovedLayouts.
export async function uploadJobAssets(input: {
  folderPath: string;
  assets: Array<{ fileName: string; docType: string; pdf: Buffer }>;
}): Promise<UploadResult[]> {
  const folder = input.folderPath.replace(/^\/+|\/+$/g, "");
  if (folder) await ensureFolder(folder);

  const results: UploadResult[] = [];
  for (const asset of input.assets) {
    const path = folder ? `${folder}/${asset.fileName}` : asset.fileName;
    const uploaded = await uploadFile(path, asset.pdf);
    results.push({ ...uploaded, docType: asset.docType });
  }
  return results;
}

// =====================================================
// Putting ONE arbitrary file into a style's "APPROVED LAYOUTS" folder.
//
// The generated-output push (push-to-supplier.ts) resolves this same target,
// but it does it for a set of JobAssets and it is welded to their approval
// state. Manually-supplied trim documents have no JobAsset and no review
// status — they are a file a person hands us — so the folder resolution is
// factored out here rather than bent into that function.
//
// The folder chain is NOT negotiable and is the whole reason this doesn't use
// client.ts's site-scoped uploadFile():
//
//   <supplier's own folder, from a sharing link>/
//     <PO> - <customer> - <supplier>/     ← SEARCHED, never created
//       APPROVED LAYOUTS/                  ← ours to get-or-create
//
// The site-scoped path needs SHAREPOINT_SITE_ID, which production does not set;
// the supplier path needs only the three Azure credentials, which it does. A
// manual trim document that landed on the site would be invisible to the
// supplier, so it goes exactly where the approved layouts go.
//
// The PO folder is never created here for the same reason the output push
// never creates it: it is owned upstream, and minting one puts files somewhere
// the supplier cannot see. A missing/ambiguous folder is reported as a typed
// refusal so the caller can store the file and say why it hasn't shipped.
// =====================================================

export type ApprovedLayoutsTarget = {
  // The supplier's "Supplier Folder" sharing URL (Supplier.sharepointUrl).
  sharingUrl: string;
  poNumber: string | null;
  // Style.supplierPoFolderName — the operator's manual pick when several
  // folders match the PO. Honoured by resolvePoFolder.
  preferredFolderName: string | null;
};

export type ApprovedLayoutsRefusal = "no-folder" | "ambiguous-folder";

export class ApprovedLayoutsFolderError extends Error {
  constructor(
    public readonly kind: ApprovedLayoutsRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ApprovedLayoutsFolderError";
  }
}

export type ResolvedApprovedLayouts = { driveId: string; folderItemId: string; webUrl: string | null };

// Resolve (and get-or-create the subfolder of) the style's APPROVED LAYOUTS
// folder. Throws ApprovedLayoutsFolderError when the PO folder is missing or
// ambiguous — both are "a human must act", never "create it anyway".
export async function resolveApprovedLayoutsFolder(
  target: ApprovedLayoutsTarget,
): Promise<ResolvedApprovedLayouts> {
  const supplierRoot = await resolveSupplierFolder(target.sharingUrl);

  const children = await listChildFolders(supplierRoot.driveId, supplierRoot.itemId);
  const resolution = resolvePoFolder(children, target.poNumber, target.preferredFolderName);

  if (resolution.status === "missing") {
    throw new ApprovedLayoutsFolderError(
      "no-folder",
      "No PO folder for this style exists in the supplier's SharePoint folder — the app never creates it. An employee must create it there first.",
    );
  }
  if (resolution.status === "ambiguous") {
    throw new ApprovedLayoutsFolderError(
      "ambiguous-folder",
      `Several folders in the supplier's SharePoint folder match this PO (${resolution.matches
        .map((m) => `“${m.name}”`)
        .join(", ")}) — there must be exactly one. Delete the extra(s), or pick one on the style, then retry.`,
    );
  }

  const subfolder = await ensureChildFolder(
    supplierRoot.driveId,
    resolution.folder.id,
    APPROVED_LAYOUTS_SUBFOLDER,
  );
  return { driveId: supplierRoot.driveId, folderItemId: subfolder.id, webUrl: subfolder.webUrl };
}

export type UploadedIntoApprovedLayouts = {
  driveId: string;
  itemId: string;
  fileName: string;
  webUrl: string | null;
  folderUrl: string | null;
};

// Upload one file under `fileName` into the style's APPROVED LAYOUTS folder.
// PUT /content replaces the bytes at the same name, so re-uploading a
// correction overwrites rather than duplicating — the caller is responsible for
// having built a name that cannot collide with ANOTHER style's file
// (manualTrimFileName does exactly that; the folder is PO-scoped, not
// style-scoped).
export async function uploadIntoApprovedLayouts(input: {
  target: ApprovedLayoutsTarget;
  fileName: string;
  content: Buffer;
}): Promise<UploadedIntoApprovedLayouts> {
  const folder = await resolveApprovedLayoutsFolder(input.target);
  const uploaded = await uploadIntoFolder(
    folder.driveId,
    folder.folderItemId,
    sanitizeFileName(input.fileName),
    input.content,
  );
  return {
    driveId: folder.driveId,
    itemId: uploaded.id,
    fileName: uploaded.name,
    webUrl: uploaded.webUrl,
    folderUrl: folder.webUrl,
  };
}

// Remove a file we previously put there, by the item id we stored. Idempotent:
// a file a person already deleted by hand resolves as alreadyGone rather than
// throwing, so removing the row never gets stuck behind a 404.
export async function removeFromApprovedLayouts(
  driveId: string,
  itemId: string,
): Promise<{ deleted: boolean; alreadyGone: boolean }> {
  return deleteDriveItem(driveId, itemId);
}
