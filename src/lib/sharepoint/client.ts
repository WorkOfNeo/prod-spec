import { getGraphClient } from "./auth";

function siteId(): string {
  const id = process.env.SHAREPOINT_SITE_ID;
  if (!id) throw new Error("SHAREPOINT_SITE_ID not set");
  return id;
}

function driveBase(): string {
  return `/sites/${siteId()}/drive`;
}

function encodePath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export type SharePointFile = {
  id: string;
  name: string;
  webUrl: string;
  size: number;
};

export async function getFile(path: string): Promise<SharePointFile | null> {
  const client = getGraphClient();
  try {
    return (await client.api(`${driveBase()}/root:/${encodePath(path)}`).get()) as SharePointFile;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function downloadFile(path: string): Promise<Buffer | null> {
  const client = getGraphClient();
  try {
    const stream = (await client
      .api(`${driveBase()}/root:/${encodePath(path)}:/content`)
      .getStream()) as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// Uploads file via Graph PUT /content (good up to ~4MB). For larger files
// switch to an upload session — we'll add that when PDFs exceed the limit.
export async function uploadFile(path: string, content: Buffer): Promise<SharePointFile> {
  const client = getGraphClient();
  return (await client
    .api(`${driveBase()}/root:/${encodePath(path)}:/content`)
    .header("Content-Type", "application/octet-stream")
    .put(content)) as SharePointFile;
}

export async function ensureFolder(path: string): Promise<void> {
  const client = getGraphClient();
  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let parent = "";
  for (const seg of segments) {
    const target = parent ? `${parent}/${seg}` : seg;
    try {
      await client.api(`${driveBase()}/root:/${encodePath(target)}`).get();
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
      const apiPath = parent ? `${driveBase()}/root:/${encodePath(parent)}:/children` : `${driveBase()}/root/children`;
      await client.api(apiPath).post({
        name: seg,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      });
    }
    parent = target;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;
}
