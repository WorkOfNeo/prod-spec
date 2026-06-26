// Shared validate-and-decode for base64 image data URLs uploaded from the
// browser (FileReader / canvas.toDataURL). One gate on type + size, used by the
// ProdSpec general-info image upload AND by rejection-comment attachments — the
// bytes land in Postgres either way.

// Accepted image types — what the browser can produce and Puppeteer can embed.
// (SVG stays allowed for the general-info markdown caller; attachment uploads
// only ever send raster png/jpeg/webp from the resize canvas.)
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

// ~5 MB decoded ceiling. base64 inflates by ~4/3, so a string already past this
// is too big to bother decoding — the zod `.max` on the field rejects it first.
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_IMAGE_DATA_URL_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024;

// data is the narrow Buffer<ArrayBuffer> that Buffer.from(string) returns —
// exactly what Prisma's Bytes input expects (a plain `Buffer`/`ArrayBufferLike`
// widens and is rejected).
export type DecodedImage = { data: Buffer<ArrayBuffer>; mimeType: string; byteSize: number; ext: string };

export type DecodeResult = { ok: true; image: DecodedImage } | { ok: false; error: string };

export function decodeImageDataUrl(dataUrl: string): DecodeResult {
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) {
    return { ok: false, error: "Expected a base64 image data URL (PNG, JPEG, WebP, GIF or SVG)" };
  }
  const mimeType = match[1];
  const data = Buffer.from(match[2], "base64");
  if (data.byteLength === 0) return { ok: false, error: "Empty image" };
  if (data.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: "Image too large — keep it under ~5 MB" };
  }
  return { ok: true, image: { data, mimeType, byteSize: data.byteLength, ext: extForMime(mimeType) } };
}

export function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}

// Strip anything path-ish / odd from a client-supplied file name. Returns null
// for empty/garbage so callers can fall back to `image.<ext>`.
export function sanitizeImageName(name: string | undefined | null): string | null {
  if (!name) return null;
  const cleaned = name.trim().replace(/[^\w.\- ]+/g, "_").slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

export type DecodedAttachment = { data: Buffer<ArrayBuffer>; mimeType: string; byteSize: number; fileName: string };

// Decode + validate a batch of inline image data URLs (the shape both reject
// routes receive) up front, before any DB write — so a single bad attachment
// 400s cleanly with no half-applied rejection. The returned shape is structural
// and feeds straight into createOrReopenRejectionTicket's `attachments`.
export function decodeImageAttachments(
  attachments: { dataUrl: string; fileName?: string }[] | undefined,
): { ok: true; attachments: DecodedAttachment[] } | { ok: false; error: string } {
  const out: DecodedAttachment[] = [];
  for (const a of attachments ?? []) {
    const decoded = decodeImageDataUrl(a.dataUrl);
    if (!decoded.ok) return { ok: false, error: decoded.error };
    out.push({
      data: decoded.image.data,
      mimeType: decoded.image.mimeType,
      byteSize: decoded.image.byteSize,
      fileName: sanitizeImageName(a.fileName) ?? `image.${decoded.image.ext}`,
    });
  }
  return { ok: true, attachments: out };
}
