import { db } from "@/lib/db";
import { ensureChildFolder } from "./supplier-folder";
import { styleSubfolderApplies, styleSubfolderName } from "./supplier-folder-names";

// =====================================================
// Which folder under "APPROVED LAYOUTS" a style delivers into.
//
//   APPROVED LAYOUTS/
//     AB10001 - Navy/      ← a style with its own subfolder
//     AB10001 - Black/
//     ab20002-….pdf        ← a style still on the flat, pre-subfolder layout
//
// Three answers, in order:
//   1. Style.supplierSubfolderName is set → that folder, always. The name is
//      PINNED the first time something lands there, so a Monday colour edit
//      after delivery can't quietly start a second folder next to the first.
//      Re-homing a style (colour fixed, or an old flat style tidied up) is the
//      explicit "move into style folder" action on /styles/[id].
//   2. Not pinned, the style's PO is at/above the style-subfolder cutoff, and
//      nothing of this style has been delivered flat yet → "<style> - <colour>",
//      computed now and pinned by ensureStyleDeliveryFolder before the first
//      byte is written.
//   3. Otherwise → null: deliver into APPROVED LAYOUTS itself, exactly as before.
//
// The "nothing delivered flat yet" condition is what keeps the rollout
// forward-only even when the cutoff is set to a PO that has already shipped:
// a re-approval on such a style would otherwise put a fresh copy in a new
// subfolder while the old one stays flat — two copies of one document for the
// supplier to choose between. Those styles stay flat until someone moves them
// on purpose ("Move to style folder" on /styles/[id]), which moves the old
// copies and pins the folder in one step.
//
// Only WRITERS ask this module. Readers (verify, reconcile, the PO checks, the
// delivery ledger) list APPROVED LAYOUTS and every subfolder in it
// (listApprovedLayoutsFiles), so they find a file wherever it sits and never
// need to agree with this decision to stay correct.
// =====================================================

// The "<style> - <colour>" name a style would get TODAY, from its render
// context — the same StyleData the cover file name reads, so the folder and
// the cover inside it name the colourway identically.
export async function computeStyleSubfolderName(styleId: string): Promise<string | null> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { name: true } });
  if (!style) return null;
  const { loadStyleRenderContext } = await import("@/lib/styles/render-context");
  // A style whose render context can't be built (Monday data gone, a layout
  // mid-publish) still gets a folder — named after the style number alone —
  // rather than failing the upload.
  const ctx = await loadStyleRenderContext(styleId).catch(() => null);
  return styleSubfolderName({
    styleNumber: ctx?.styleData.styleNumber?.trim() || style.name,
    colour: ctx?.styleData.colour ?? null,
  });
}

// The subfolder the NEXT upload for this style goes into, or null for the flat
// layout. See the header for the order.
export async function styleSubfolderForUpload(styleId: string): Promise<string | null> {
  const style = await db.style
    .findUnique({ where: { id: styleId }, select: { poSeq: true, supplierSubfolderName: true } })
    // The column arrives with a migration; until it has run, behave exactly as
    // the app did before subfolders existed rather than fail every upload.
    .catch(() => null);
  if (!style) return null;
  if (style.supplierSubfolderName?.trim()) return style.supplierSubfolderName.trim();

  const { getStyleSubfolderMinPo } = await import("@/lib/settings/app-settings");
  const minPo = await getStyleSubfolderMinPo().catch(() => null);
  if (!styleSubfolderApplies(style.poSeq, minPo)) return null;
  if (await hasFlatDeliveries(styleId)) return null;
  return computeStyleSubfolderName(styleId);
}

// Has anything of this style already reached APPROVED LAYOUTS (while it had no
// subfolder, so: flat)? A queue row that was uploaded or emailed, or a manual
// document that was delivered. Unsure (the read failed) counts as yes — the
// safe answer is the layout the style already has.
async function hasFlatDeliveries(styleId: string): Promise<boolean> {
  try {
    const [queued, manual] = await Promise.all([
      db.supplierSendQueueItem.count({
        where: { styleId, OR: [{ sharePointStatus: "UPLOADED" }, { sharePointUrl: { not: null } }] },
      }),
      db.styleManualTrimUpload.count({ where: { styleId, sharepointItemId: { not: null } } }),
    ]);
    return queued + manual > 0;
  } catch {
    return true;
  }
}

// Get-or-create the style's subfolder under APPROVED LAYOUTS and pin its name
// on the style. The pin is written BEFORE the caller uploads anything, and a
// failed pin fails the upload: a file landing in a folder the style doesn't
// remember would make the next upload (after a colour edit) pick a different
// folder and split the style in two.
export async function ensureStyleDeliveryFolder(input: {
  driveId: string;
  approvedLayoutsItemId: string;
  styleId: string;
  subfolderName: string;
}): Promise<{ id: string; webUrl: string | null }> {
  const folder = await ensureChildFolder(input.driveId, input.approvedLayoutsItemId, input.subfolderName);
  await db.style.update({
    where: { id: input.styleId },
    data: { supplierSubfolderName: input.subfolderName },
  });
  return folder;
}
