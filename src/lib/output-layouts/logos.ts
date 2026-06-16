import { promises as fs } from "node:fs";
import path from "node:path";

// =====================================================
// Logos for {{logo:contrast}} / {{logo:contrastAddress}} / {{logo:custom}}
// (SERVER-ONLY).
//
//   • CONTRAST          — a static asset committed at
//     public/logos/contrast.svg (preferred) or .png/.jpg.
//   • CONTRAST (ADDRESS) — same idea, the address-bearing variant, at
//     public/logos/contrast-address.svg (or .png/.jpg). So both are usable.
//   Both are inlined as a data URL at render time so the PDF needs no
//   network fetch.
//
//   • CUSTOM — stored PER LAYOUT on OutputLayout.customLogo (uploaded in the
//     Output Builder) and threaded into the renderer via the render options,
//     NOT loaded here. The old global AppSetting logo was removed.
// =====================================================

const MIME_BY_EXT: Array<{ ext: string; mime: string }> = [
  { ext: "svg", mime: "image/svg+xml" },
  { ext: "png", mime: "image/png" },
  { ext: "jpg", mime: "image/jpeg" },
];

const TTL_MS = 30_000;
const repoLogoCache = new Map<string, { at: number; dataUrl: string | null }>();

// Load a committed repo logo by base name (e.g. "contrast",
// "contrast-address"), trying svg → png → jpg. Cached per base name.
async function getRepoLogoDataUrl(baseName: string): Promise<string | null> {
  const cached = repoLogoCache.get(baseName);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.dataUrl;
  let dataUrl: string | null = null;
  for (const { ext, mime } of MIME_BY_EXT) {
    try {
      const buf = await fs.readFile(path.join(process.cwd(), "public", "logos", `${baseName}.${ext}`));
      dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      break;
    } catch {
      // try the next extension
    }
  }
  repoLogoCache.set(baseName, { at: Date.now(), dataUrl });
  return dataUrl;
}

export function getContrastLogoDataUrl(): Promise<string | null> {
  return getRepoLogoDataUrl("contrast");
}

export function getContrastAddressLogoDataUrl(): Promise<string | null> {
  return getRepoLogoDataUrl("contrast-address");
}
