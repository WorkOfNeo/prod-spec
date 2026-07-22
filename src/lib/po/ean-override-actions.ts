import { db } from "@/lib/db";
import { isValidEan13 } from "@/lib/pdf/barcode";
import { type EanView, toEanSize } from "./ean-view";

// =====================================================
// Manual EAN overrides for one style (style-page EAN panel). These mutate
// style_eans directly (no SharePoint round-trip) and are folded back into the
// next scrape by reconcileEans (see ean-overrides.ts), so they persist.
//
// Deliberately does NOT recompute Style.eanStatus: an operator hiding a row is
// an intentional, trusted action, so it must not flip a style to partial /
// not-ready. Status stays whatever the last real resolve set.
// =====================================================

export type EanOverrideOp =
  | { op: "toggle"; id: string; excluded: boolean }
  | { op: "add"; size: string; ean13: string }
  | { op: "delete"; id: string };

export class EanOverrideError extends Error {}

// Rebuild the UI-facing view from the persisted rows (no re-resolve). Shares
// the exact row→view mapping the page loader and the runner use.
export async function loadStyleEanView(styleId: string): Promise<EanView> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      eanStatus: true,
      poFileName: true,
      cartonEan: true,
      eans: {
        orderBy: { position: "asc" },
        select: { id: true, size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true, manual: true },
      },
    },
  });
  if (!style) throw new EanOverrideError("Style not found");
  return {
    status: style.eanStatus,
    poFileName: style.poFileName,
    cartonEan: style.cartonEan,
    sizeEans: style.eans.map(toEanSize),
  };
}

export async function applyEanOverride(styleId: string, op: EanOverrideOp): Promise<EanView> {
  switch (op.op) {
    case "toggle": {
      // Scope the update by styleId too, so an id from another style can't be
      // toggled through this style's endpoint.
      const res = await db.styleEan.updateMany({
        where: { id: op.id, styleId },
        data: { excluded: op.excluded },
      });
      if (res.count === 0) throw new EanOverrideError("EAN row not found on this style");
      break;
    }
    case "add": {
      const size = op.size.trim();
      const ean13 = op.ean13.trim();
      if (!size) throw new EanOverrideError("Size is required");
      if (!/^\d{13}$/.test(ean13)) throw new EanOverrideError("EAN must be 13 digits");
      if (!isValidEan13(ean13)) throw new EanOverrideError("Invalid EAN-13 check digit");

      // Refuse an exact duplicate (same size + EAN already present) so a manual
      // add can't create a twin of a scraped row.
      const dup = await db.styleEan.findFirst({ where: { styleId, size, ean13 } });
      if (dup) throw new EanOverrideError("That size + EAN is already on this style");

      const last = await db.styleEan.findFirst({
        where: { styleId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      await db.styleEan.create({
        data: {
          styleId,
          position: (last?.position ?? -1) + 1,
          size,
          ean13,
          variantLabel: "manual entry",
          cartonEan: null,
          manual: true,
          excluded: false,
        },
      });
      break;
    }
    case "delete": {
      // Only hand-added rows can be deleted — a scraped row would just come
      // back on the next re-resolve, so the panel offers "hide" for those.
      const res = await db.styleEan.deleteMany({ where: { id: op.id, styleId, manual: true } });
      if (res.count === 0) {
        throw new EanOverrideError("Only manually-added rows can be deleted (hide scraped rows instead)");
      }
      break;
    }
  }
  return loadStyleEanView(styleId);
}
