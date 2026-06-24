import { db } from "@/lib/db";

// =====================================================
// Inline ProdSpec "General information" images for PDF rendering.
//
// The general-info markdown references uploaded images by a short serve URL
// (/api/admin/prod-specs/<prodSpecId>/images/<imageId>). The browser editor and
// the preview iframe resolve that path directly, but the PDF renderer loads
// HTML via page.setContent() with NO base URL (src/lib/pdf/renderer.ts), so a
// bare same-origin path never loads at print time. We rewrite each such <img>
// src into a self-contained data URL, reading the bytes from Postgres — the
// same trick src/lib/output-layouts/logos.ts uses for repo logos.
//
// Tags whose imageId no longer exists are dropped, so a deleted image prints
// as nothing rather than a broken-image box.
// =====================================================

// One <img …> tag. HTML from marked is well-formed (no nested `>` in attrs).
const IMG_TAG_RE = /<img\b[^>]*>/gi;
// The src attribute within a tag (double-quoted, as marked emits).
const SRC_ATTR_RE = /\ssrc\s*=\s*"([^"]*)"/i;

export async function inlineProdSpecImages(html: string, prodSpecId: string): Promise<string> {
  // Match this prod spec's serve path, optionally behind an absolute origin.
  // The imageId is a cuid (alnum, plus the `-`/`_` a cuid can't actually emit
  // but we accept defensively).
  const srcRe = new RegExp(
    `^(?:https?://[^/]+)?/api/admin/prod-specs/${escapeRe(prodSpecId)}/images/([A-Za-z0-9_-]+)$`,
  );

  // First pass — collect referenced image ids without touching the string.
  const ids = new Set<string>();
  for (const [tag] of html.matchAll(IMG_TAG_RE)) {
    const src = SRC_ATTR_RE.exec(tag)?.[1]?.trim();
    const id = src ? srcRe.exec(src)?.[1] : undefined;
    if (id) ids.add(id);
  }
  if (ids.size === 0) return html;

  const rows = await db.prodSpecImage.findMany({
    where: { prodSpecId, id: { in: [...ids] } },
    select: { id: true, mimeType: true, data: true },
  });
  const dataUrlById = new Map(
    rows.map((r) => [r.id, `data:${r.mimeType};base64,${Buffer.from(r.data).toString("base64")}`]),
  );

  // Second pass — swap each matching src for its data URL (preserving alt and
  // any other attributes), or drop the tag when the image is gone.
  return html.replace(IMG_TAG_RE, (tag) => {
    const src = SRC_ATTR_RE.exec(tag)?.[1]?.trim();
    const id = src ? srcRe.exec(src)?.[1] : undefined;
    if (!id) return tag; // not one of ours — leave external/remote imgs alone
    const dataUrl = dataUrlById.get(id);
    if (!dataUrl) return ""; // image deleted — drop it
    return tag.replace(SRC_ATTR_RE, ` src="${dataUrl}"`);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
