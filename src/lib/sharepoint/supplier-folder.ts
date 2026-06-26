import { getGraphClient } from "./auth";
import { getSharedItem, type SharedDriveItem } from "./shares";

// =====================================================
// WRITE side of a supplier's SharePoint folder. shares.ts READS supplier
// folders via their sharing URL (Sites.Read.All); this module drops files
// INTO them. The configured-site client.ts can't reach these folders — they
// live on the Contrast-Suppliers site, addressed by (driveId + itemId)
// resolved from the supplier's "Supplier Folder" sharing link.
//
// Writing needs Sites.ReadWrite.All (or Sites.Selected + a write grant on the
// Contrast-Suppliers site). Until IT (FLC) grants it, the POST/PUT below come
// back 403 — surfaced distinctly via SharePointWriteForbiddenError so a
// permission gap reads clearly instead of as a generic failure. Resolution
// (the read in resolveSupplierFolder) works today, so the whole target path is
// verifiable with ?dryRun=1 before write is enabled.
// =====================================================

export type ResolvedFolder = { driveId: string; itemId: string; webUrl: string | null };

// Raised when Graph refuses a write with 403 — almost always "the app
// registration has read but not write on Contrast-Suppliers yet".
export class SharePointWriteForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharePointWriteForbiddenError";
  }
}

function statusCodeOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null) {
    const s = (err as { statusCode?: number }).statusCode;
    if (typeof s === "number") return s;
  }
  return null;
}

const WRITE_FORBIDDEN_HINT =
  "the app needs write access to the Contrast-Suppliers SharePoint site";

// SharePoint/OneDrive forbid \ / : * ? " < > | in item names and any control
// characters, and reject leading/trailing spaces or dots. Replace illegal
// chars with a space, collapse whitespace, and trim. Everything else (the
// en-dash in "Style – Customer") is kept. Capped under the ~255 name limit.
const ILLEGAL_NAME_CHARS = '\\/:*?"<>|';

export function sanitizeName(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || ILLEGAL_NAME_CHARS.includes(ch) ? " " : ch;
  }
  const cleaned = out
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // no leading dots
    .replace(/[. ]+$/, "") // no trailing dots/spaces
    .trim()
    .slice(0, 200)
    .trim();
  return cleaned || "untitled";
}

// Resolve a supplier's "Supplier Folder" sharing URL to a writable target
// (driveId + itemId). Read-only — works before write is granted.
export async function resolveSupplierFolder(sharingUrl: string): Promise<ResolvedFolder> {
  const item = await getSharedItem(sharingUrl);
  const driveId = item.parentReference?.driveId;
  if (!driveId || !item.id) {
    throw new Error("the link did not resolve to a SharePoint drive item");
  }
  if (!item.folder) {
    throw new Error("the link points at a file, not a folder");
  }
  return { driveId, itemId: item.id, webUrl: item.webUrl ?? null };
}

// Ensure a child folder by name exists under (driveId + parentItemId), reusing
// it when present. Addresses the child by path (O(1), and unaffected by how
// many sibling folders the supplier already has), mirroring client.ts'
// get-by-path-then-create-on-404 pattern. Returns the folder id + webUrl.
export async function ensureChildFolder(
  driveId: string,
  parentItemId: string,
  name: string,
): Promise<{ id: string; webUrl: string | null }> {
  const client = getGraphClient();
  const encoded = encodeURIComponent(name);
  const childByPath = `/drives/${driveId}/items/${parentItemId}:/${encoded}`;

  try {
    const existing = (await client.api(childByPath).get()) as SharedDriveItem;
    if (existing?.id) return { id: existing.id, webUrl: existing.webUrl ?? null };
  } catch (err) {
    const code = statusCodeOf(err);
    if (code === 403) {
      throw new SharePointWriteForbiddenError(`SharePoint denied access (403) — ${WRITE_FORBIDDEN_HINT}`);
    }
    // Only fall through to create on a genuine "not found".
    if (code !== 404) throw err;
  }

  try {
    const created = (await client.api(`/drives/${driveId}/items/${parentItemId}/children`).post({
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    })) as SharedDriveItem;
    return { id: created.id, webUrl: created.webUrl ?? null };
  } catch (err) {
    if (statusCodeOf(err) === 403) {
      throw new SharePointWriteForbiddenError(`SharePoint refused folder creation (403) — ${WRITE_FORBIDDEN_HINT}`);
    }
    // A racing create can 409 (nameAlreadyExists) — re-fetch and reuse.
    if (statusCodeOf(err) === 409) {
      const again = (await client.api(childByPath).get()) as SharedDriveItem;
      if (again?.id) return { id: again.id, webUrl: again.webUrl ?? null };
    }
    throw err;
  }
}

// Upload bytes as a file under (driveId + folderItemId). PUT /content replaces
// existing content at the same name — so re-pushing a re-approved correction
// overwrites the prior file. Direct PUT is good up to ~4MB (same limit as
// client.ts); switch to an upload session if output PDFs ever exceed it.
export async function uploadIntoFolder(
  driveId: string,
  folderItemId: string,
  fileName: string,
  content: Buffer,
): Promise<{ id: string; name: string; webUrl: string | null; size: number }> {
  const client = getGraphClient();
  const encoded = encodeURIComponent(fileName);
  try {
    const res = (await client
      .api(`/drives/${driveId}/items/${folderItemId}:/${encoded}:/content`)
      .header("Content-Type", "application/octet-stream")
      .put(content)) as SharedDriveItem;
    return { id: res.id, name: res.name, webUrl: res.webUrl ?? null, size: res.size ?? content.length };
  } catch (err) {
    if (statusCodeOf(err) === 403) {
      throw new SharePointWriteForbiddenError(`SharePoint refused the upload (403) — ${WRITE_FORBIDDEN_HINT}`);
    }
    throw err;
  }
}
