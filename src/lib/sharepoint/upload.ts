import { ensureFolder, uploadFile, type SharePointFile } from "./client";

export type UploadResult = SharePointFile & { docType: string };

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
