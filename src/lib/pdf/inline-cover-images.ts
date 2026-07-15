import { db } from "@/lib/db";

// =====================================================
// Inline GLOBAL cover-page content images for PDF rendering.
//
// The global cover block (AppSetting "coverPageInfoMd") references uploaded
// images by a short serve URL (/api/admin/settings/cover-page/images/<imageId>).
// The browser editor and the preview iframe resolve that path directly, but the
// PDF renderer loads HTML via page.setContent() with NO base URL, so a bare
// same-origin path never loads at print time. We rewrite each such <img> src
// into a self-contained data URL, reading the bytes from Postgres — the global
// twin of inlineProdSpecImages (src/lib/pdf/inline-images.ts).
//
// Fail-soft: if the cover_page_images table isn't deployed yet, or a referenced
// image is gone, the tag is dropped rather than breaking the whole cover render.
// =====================================================

// One <img …> tag. HTML from marked is well-formed (no nested `>` in attrs).
const IMG_TAG_RE = /<img\b[^>]*>/gi;
// The src attribute within a tag (double-quoted, as marked emits).
const SRC_ATTR_RE = /\ssrc\s*=\s*"([^"]*)"/i;
// The global cover-image serve path, optionally behind an absolute origin. The
// imageId is a cuid (alnum, plus the `-`/`_` a cuid can't actually emit but we
// accept defensively).
const SRC_RE =
  /^(?:https?:\/\/[^/]+)?\/api\/admin\/settings\/cover-page\/images\/([A-Za-z0-9_-]+)$/;

export async function inlineCoverPageImages(html: string): Promise<string> {
  // First pass — collect referenced image ids without touching the string.
  const ids = new Set<string>();
  for (const [tag] of html.matchAll(IMG_TAG_RE)) {
    const src = SRC_ATTR_RE.exec(tag)?.[1]?.trim();
    const id = src ? SRC_RE.exec(src)?.[1] : undefined;
    if (id) ids.add(id);
  }
  if (ids.size === 0) return html;

  // Fail-soft on a missing table (pre-db:deploy) — the cover still renders,
  // just without the global images.
  let dataUrlById = new Map<string, string>();
  try {
    const rows = await db.coverPageImage.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, mimeType: true, data: true },
    });
    dataUrlById = new Map(
      rows.map((r) => [r.id, `data:${r.mimeType};base64,${Buffer.from(r.data).toString("base64")}`]),
    );
  } catch (err) {
    console.warn(`[inline-cover-images] table read failed (dropping ${ids.size} image(s)):`, err);
  }

  // Second pass — swap each matching src for its data URL (preserving alt and
  // any other attributes), or drop the tag when the image is gone.
  return html.replace(IMG_TAG_RE, (tag) => {
    const src = SRC_ATTR_RE.exec(tag)?.[1]?.trim();
    const id = src ? SRC_RE.exec(src)?.[1] : undefined;
    if (!id) return tag; // not one of ours — leave external/remote imgs alone
    const dataUrl = dataUrlById.get(id);
    if (!dataUrl) return ""; // image deleted / table missing — drop it
    return tag.replace(SRC_ATTR_RE, ` src="${dataUrl}"`);
  });
}
