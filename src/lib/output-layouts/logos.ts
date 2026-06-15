import { promises as fs } from "node:fs";
import path from "node:path";

// =====================================================
// Logos for {{logo:contrast}} / {{logo:custom}} (SERVER-ONLY).
//
//   • CONTRAST — a static asset committed to the repo at
//     public/logos/contrast.svg (preferred) or .png/.jpg. Inlined as a
//     data URL at render time so the PDF needs no network fetch.
//   • CUSTOM   — now stored PER LAYOUT on OutputLayout.customLogo (uploaded
//     in the Output Builder) and threaded into the renderer via the render
//     options, NOT loaded here. The old global AppSetting logo was removed.
// =====================================================

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
