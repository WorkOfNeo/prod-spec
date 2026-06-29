import { db } from "@/lib/db";
import type { GeneralInfoImage } from "@/lib/pdf/bundle-pages";

// Load a prod spec's General-information images as ordered, self-contained data
// URLs for PDF rendering. The renderer loads HTML via page.setContent() with no
// base URL (src/lib/pdf/renderer.ts), so a bare /api path never resolves at
// print time — we inline the bytes here, lowest sortOrder first (createdAt
// breaks ties), matching the editor's Images-tab order. Same trick as
// src/lib/output-layouts/logos.ts.
export async function loadGeneralInfoImages(prodSpecId: string): Promise<GeneralInfoImage[]> {
  const rows = await db.prodSpecImage.findMany({
    where: { prodSpecId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { mimeType: true, data: true, fileName: true },
  });
  return rows.map((r) => ({
    dataUrl: `data:${r.mimeType};base64,${Buffer.from(r.data).toString("base64")}`,
    alt: r.fileName,
  }));
}
