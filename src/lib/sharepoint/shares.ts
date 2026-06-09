import { getGraphClient } from "./auth";

// =====================================================
// Access a SharePoint folder/file shared via a sharing URL (the kind stored
// on the Suppliers board's "Supplier Folder" link column). Unlike client.ts
// — which works against one configured site drive by path — this resolves
// an arbitrary sharing URL through Graph's /shares endpoint, so it reaches
// supplier folders on other sites (e.g. Contrast-Suppliers) using the same
// app-only credentials (needs Sites.Read.All).
// =====================================================

export type SharedDriveItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  "@microsoft.graph.downloadUrl"?: string;
  parentReference?: { driveId?: string };
};

// Graph "share id" encoding for a sharing URL: base64, made URL-safe, with
// the "u!" prefix. Handles ":f:" folder links and ":b:" file links alike.
export function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url, "utf-8").toString("base64");
  return "u!" + b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

// Resolve the driveItem a sharing URL points at (a folder or a file).
export async function getSharedItem(sharingUrl: string): Promise<SharedDriveItem> {
  const client = getGraphClient();
  return (await client.api(`/shares/${encodeSharingUrl(sharingUrl)}/driveItem`).get()) as SharedDriveItem;
}

// List the immediate children of a shared folder.
export async function listSharedFolder(sharingUrl: string): Promise<SharedDriveItem[]> {
  const client = getGraphClient();
  const res = (await client
    .api(`/shares/${encodeSharingUrl(sharingUrl)}/driveItem/children`)
    .get()) as { value: SharedDriveItem[] };
  return res.value ?? [];
}

function dedupById(items: SharedDriveItem[]): SharedDriveItem[] {
  const out: SharedDriveItem[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (i.id && !seen.has(i.id)) {
      seen.add(i.id);
      out.push(i);
    }
  }
  return out;
}

// Recursively search a shared folder (any depth) for items matching a
// query. Deduped by item id.
export async function searchSharedFolder(
  sharingUrl: string,
  query: string,
): Promise<SharedDriveItem[]> {
  const root = await getSharedItem(sharingUrl);
  const driveId = root.parentReference?.driveId;
  if (!driveId) return [];
  const client = getGraphClient();
  const q = query.replace(/'/g, "''");
  const res = (await client
    .api(`/drives/${driveId}/items/${root.id}/search(q='${q}')`)
    .get()) as { value: SharedDriveItem[] };
  return dedupById(res.value ?? []);
}

// The Contrast-Suppliers site's "Suppliers" library holds every supplier's
// folder. Searching it once by the (unique) PO number is the most reliable
// way to find a PO PDF — it doesn't depend on each supplier's folder URL
// being clean. Site/drive resolution is cached per process.
let cachedSuppliersDriveId: string | null = null;

export async function getSuppliersDriveId(): Promise<string | null> {
  if (cachedSuppliersDriveId) return cachedSuppliersDriveId;
  const client = getGraphClient();
  const sitePath =
    process.env.SHAREPOINT_SUPPLIERS_SITE ?? "contrastcompany.sharepoint.com:/sites/Contrast-Suppliers";
  const driveName = process.env.SHAREPOINT_SUPPLIERS_DRIVE ?? "Suppliers";
  const site = (await client.api(`/sites/${sitePath}`).get()) as { id: string };
  const drives = (await client.api(`/sites/${site.id}/drives`).get()) as {
    value: Array<{ name: string; id: string }>;
  };
  cachedSuppliersDriveId = drives.value.find((d) => d.name === driveName)?.id ?? null;
  return cachedSuppliersDriveId;
}

export async function searchSuppliersDrive(query: string): Promise<SharedDriveItem[]> {
  const driveId = await getSuppliersDriveId();
  if (!driveId) return [];
  const client = getGraphClient();
  const q = query.replace(/'/g, "''");
  const res = (await client
    .api(`/drives/${driveId}/root/search(q='${q}')`)
    .get()) as { value: SharedDriveItem[] };
  return dedupById(res.value ?? []);
}

// List children of a sub-item within a resolved drive (driveId + itemId).
export async function listDriveChildren(driveId: string, itemId: string): Promise<SharedDriveItem[]> {
  const client = getGraphClient();
  const res = (await client.api(`/drives/${driveId}/items/${itemId}/children`).get()) as {
    value: SharedDriveItem[];
  };
  return res.value ?? [];
}

// Download a drive item's bytes via its short-lived pre-authenticated URL,
// falling back to the Graph /content endpoint when the URL isn't present.
export async function downloadDriveItem(item: SharedDriveItem): Promise<Buffer | null> {
  const direct = item["@microsoft.graph.downloadUrl"];
  if (direct) {
    const res = await fetch(direct);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  const driveId = item.parentReference?.driveId;
  if (!driveId) return null;
  const client = getGraphClient();
  const stream = (await client
    .api(`/drives/${driveId}/items/${item.id}/content`)
    .getStream()) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
