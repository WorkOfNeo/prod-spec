import { isSharepointConfigured } from "@/lib/publish/publish-approved-job";
import {
  resolveSupplierFolder,
  listChildFolders,
  resolvePoFolder,
} from "./supplier-folder";
import { listDriveChildren } from "./shares";

// =====================================================
// Read-only "how many files are in this style's PO folder" — powers the live
// number on the Supplier folder panel. Resolves the supplier's SharePoint root
// (Supplier.sharepointUrl), finds the folder whose name contains the PO number
// (the SAME match the upload sweep uses — resolvePoFolder), then counts the
// files inside it. All READ calls; safe before write access is granted.
//
// The count includes files directly in the PO folder AND files one level down
// (the "APPROVED LAYOUTS" subfolder is where approved PDFs land) so the number
// reflects what a person opening the folder would actually see. Bounded to one
// level so a page render never fans out unboundedly.
// =====================================================

export type PoFolderFilesStatus =
  | "found" // exactly one PO folder — folders[0] carries the count
  | "ambiguous" // several folders match the PO — one entry each
  | "missing" // no folder matches the PO number
  | "no-supplier" // no supplier linked on the style
  | "no-link" // supplier linked but has no folder URL
  | "no-po" // style has no PO number to match on
  | "not-configured" // SharePoint app credentials absent
  | "error"; // Graph call failed (blank/stale link, 403, throttle…)

export type PoFolderFiles = {
  status: PoFolderFilesStatus;
  poNumber: string | null;
  // One entry per matched PO folder (exactly one for "found", ≥2 for "ambiguous").
  folders: Array<{ name: string; webUrl: string | null; fileCount: number }>;
  error?: string;
};

// Files directly in the folder plus files in each immediate subfolder — the
// "APPROVED LAYOUTS" subfolder holds the approved PDFs, so a parent-only count
// would read 0 even when the folder is full. One level deep only.
async function countFiles(driveId: string, folderId: string): Promise<number> {
  const top = await listDriveChildren(driveId, folderId);
  let files = top.filter((i) => i.file).length;
  for (const sub of top) {
    if (!sub.folder || !sub.id) continue;
    const kids = await listDriveChildren(driveId, sub.id);
    files += kids.filter((i) => i.file).length;
  }
  return files;
}

export async function countPoFolderFiles(opts: {
  hasSupplier: boolean;
  supplierUrl: string | null;
  poNumber: string | null;
}): Promise<PoFolderFiles> {
  const { hasSupplier, supplierUrl } = opts;
  const poNumber = opts.poNumber?.trim() || null;

  if (!hasSupplier) return { status: "no-supplier", poNumber, folders: [] };
  if (!supplierUrl) return { status: "no-link", poNumber, folders: [] };
  if (!poNumber) return { status: "no-po", poNumber, folders: [] };
  if (!isSharepointConfigured()) return { status: "not-configured", poNumber, folders: [] };

  try {
    const { driveId, itemId } = await resolveSupplierFolder(supplierUrl);
    const children = await listChildFolders(driveId, itemId);
    const res = resolvePoFolder(children, poNumber);
    if (res.status === "missing") return { status: "missing", poNumber, folders: [] };

    const matched = res.status === "found" ? [res.folder] : res.matches;
    const folders = await Promise.all(
      matched.map(async (f) => ({
        name: f.name,
        webUrl: f.webUrl,
        fileCount: await countFiles(driveId, f.id),
      })),
    );
    return {
      status: res.status === "found" ? "found" : "ambiguous",
      poNumber,
      folders,
    };
  } catch (e) {
    return {
      status: "error",
      poNumber,
      folders: [],
      error: e instanceof Error ? e.message : "SharePoint lookup failed",
    };
  }
}
