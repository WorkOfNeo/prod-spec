import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

// =====================================================
// Logos for {{logo:contrast}} / {{logo:custom}} (SERVER-ONLY).
//
//   • CONTRAST — a static asset committed to the repo at
//     public/logos/contrast.svg (preferred) or .png/.jpg. Inlined as a
//     data URL at render time so the PDF needs no network fetch.
//   • CUSTOM   — uploaded in the app (Output builder list → Logos card),
//     stored as a data URL in the AppSetting key-value store. Global —
//     one custom logo for all layouts.
// =====================================================

const CUSTOM_LOGO_KEY = "outputBuilderCustomLogo";

const CONTRAST_CANDIDATES: Array<{ file: string; mime: string }> = [
  { file: "contrast.svg", mime: "image/svg+xml" },
  { file: "contrast.png", mime: "image/png" },
  { file: "contrast.jpg", mime: "image/jpeg" },
];

let contrastCache: { at: number; dataUrl: string | null } | null = null;
const TTL_MS = 30_000;

export async function getContrastLogoDataUrl(): Promise<string | null> {
  if (contrastCache && Date.now() - contrastCache.at < TTL_MS) return contrastCache.dataUrl;
  let dataUrl: string | null = null;
  for (const c of CONTRAST_CANDIDATES) {
    try {
      const buf = await fs.readFile(path.join(process.cwd(), "public", "logos", c.file));
      dataUrl = `data:${c.mime};base64,${buf.toString("base64")}`;
      break;
    } catch {
      // try the next candidate
    }
  }
  contrastCache = { at: Date.now(), dataUrl };
  return dataUrl;
}

export async function getCustomLogoDataUrl(): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key: CUSTOM_LOGO_KEY } });
  const v = row?.value;
  return typeof v === "string" && v.startsWith("data:image/") ? v : null;
}

export async function setCustomLogoDataUrl(dataUrl: string | null): Promise<void> {
  if (dataUrl === null) {
    await db.appSetting.deleteMany({ where: { key: CUSTOM_LOGO_KEY } });
    return;
  }
  await db.appSetting.upsert({
    where: { key: CUSTOM_LOGO_KEY },
    update: { value: dataUrl },
    create: { key: CUSTOM_LOGO_KEY, value: dataUrl },
  });
}
