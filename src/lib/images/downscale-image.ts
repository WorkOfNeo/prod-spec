// Browser-only. Prepare a user-picked image for upload: downscale it so the
// longest edge is <= MAX_EDGE and the encoded size sits comfortably under the
// server's ~5 MB ceiling, returning a base64 data URL ready to POST inline with
// a rejection comment. Small images pass through untouched (best fidelity);
// PNGs stay PNG to keep screenshot text crisp, everything else re-encodes to
// JPEG. Do NOT import from server code — it touches document/Image/canvas.

const MAX_EDGE = 2000; // longest edge in px after downscale
const JPEG_QUALITY = 0.85;
const TARGET_BYTES = 4_000_000; // stay under the 5 MB server cap with slack

export type PreparedImage = { dataUrl: string; fileName: string };

export async function downscaleImage(file: File): Promise<PreparedImage> {
  const img = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > 0 ? Math.min(1, MAX_EDGE / longest) : 1;

  // Already small enough and not too heavy → keep the original bytes verbatim.
  if (scale === 1 && file.size <= TARGET_BYTES) {
    return { dataUrl: await readAsDataUrl(file), fileName: file.name };
  }

  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // No canvas (very old/headless browser) — fall back to the raw file and let
    // the server-side size cap do the gatekeeping.
    return { dataUrl: await readAsDataUrl(file), fileName: file.name };
  }
  ctx.drawImage(img, 0, 0, w, h);

  const keepPng = file.type === "image/png";
  let dataUrl = keepPng
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", JPEG_QUALITY);

  // If a downscaled PNG is still heavy (large flat screenshots can be), or a
  // JPEG somehow overshoots, step quality down on a JPEG re-encode until it fits.
  if (estimateBytes(dataUrl) > TARGET_BYTES) {
    for (let q = JPEG_QUALITY; q >= 0.3; q -= 0.15) {
      dataUrl = canvas.toDataURL("image/jpeg", q);
      if (estimateBytes(dataUrl) <= TARGET_BYTES) break;
    }
  }

  const outIsPng = dataUrl.startsWith("data:image/png");
  return { dataUrl, fileName: renameExt(file.name, outIsPng ? "png" : "jpg") };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image"));
    };
    img.src = url;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read this file"));
    reader.readAsDataURL(file);
  });
}

// Decoded byte size of a base64 data URL, from its base64 payload length.
function estimateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function renameExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "image"}.${ext}`;
}
