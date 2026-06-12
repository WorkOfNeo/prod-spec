import { promises as fs } from "node:fs";
import path from "node:path";

// =====================================================
// Logos for {{logo:contrast}} (SERVER-ONLY).
//
//   • CONTRAST — a static asset committed to the repo at
//     public/logos/contrast.svg (preferred) or .png/.jpg. Inlined as a
//     data URL at render time so the PDF needs no network fetch.
//   • CUSTOM   — NOT here any more: {{logo:custom}} renders the
//     LogoImage linked on each STYLE (Style.logoImageId, library at
//     /settings/logos), resolved onto StyleData.styleLogo by the
//     runner / render-context. The old global AppSetting
//     ("outputBuilderCustomLogo") is retired; its value was migrated
//     into the library as the first entry.
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
