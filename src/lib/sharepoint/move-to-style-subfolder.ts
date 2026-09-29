import { sanitizeFileName, type ApprovedLayoutsFile } from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";

// =====================================================
// Per-style "move into style folder" — the manual, on-demand half of the
// per-style subfolder layout.
//
// From the style-subfolder PO cutoff on, pushes land in
// "APPROVED LAYOUTS/<style> - <colour>/". Everything delivered BEFORE that sits
// flat in "APPROVED LAYOUTS/", and it stays there: the rollout is forward-only
// and nothing is moved behind anyone's back. This action is how an operator
// tidies ONE style up from /styles/[id] — it finds the files already delivered
// for that style, moves them into the style's own folder and cleans up after
// itself. The same action re-homes a style whose colour was corrected after its
// folder was created (the old subfolder's files move to the new name and the
// emptied old folder is removed).
//
// WHICH FILES ARE "THIS STYLE'S". The flat folder is PO-scoped and routinely
// holds several styles — often the same style number in several colourways —
// so a file is only attributed to this style when:
//   • it is one of this style's manually supplied documents (matched by the
//     Graph item id we stored when we uploaded it — provably ours), or
//   • its name is one this style's current outputs were generated under, or
//     are called today (the stamp or the layout's current template).
// A name that ALSO belongs to another style on the PO (two colourways stamped
// the same "00-ab10001-cover-page.pdf" before covers carried the colour) is
// NOT moved: nothing in the file says whose artwork it is, and moving it would
// take the sibling's only copy away. Instead this style's own approved bytes
// (JobAsset.pdf — unambiguously this style's) are uploaded into its folder and
// the shared file is left where it is for the sibling.
//
// Everything else — files no style on the PO accounts for, files in another
// style's subfolder — is left untouched and not even listed: this action moves
// one style's files, it is not a folder cleanup.
//
// ORDER IS THE SAFETY PROPERTY, as in repushRenamedFiles: moves are PATCHes of
// the same item (same bytes, same version history), so the file is never absent;
// a copy uploads before anything is deleted; and a flat file is only deleted
// when an identically named copy is ALREADY in the style's folder (a push landed
// there after the cutoff while the old copy stayed flat).
//
// Always previewed first: the route runs a dry run that returns the exact plan,
// the panel shows it, and only an explicit confirm applies it — re-planned
// against a FRESH listing, so a file that moved in between is never acted on
// from a stale picture.
//
// Structure: planStyleFolderMove is pure and unit tested; the Graph/DB shell
// below it loads its imports lazily so the test needs no database.
// =====================================================

export type MoveAction =
  | "move" // PATCH the file into the style's folder
  | "remove-duplicate" // the style's folder already has this name — delete the flat copy
  | "copy" // name shared with a sibling — upload this style's own bytes, leave the original
  | "left"; // attributable to this style but nothing can be done (see reason)

export type MovePlanItem = {
  itemId: string;
  fileName: string;
  // Where the file is now: "APPROVED LAYOUTS" or "APPROVED LAYOUTS/<old subfolder>".
  from: string;
  action: MoveAction;
  // The style's output behind this name, when it is one (null for a manual
  // document or a file from the style's previous subfolder). For a copy, the
  // asset whose bytes get uploaded.
  jobAssetId: string | null;
  // Other styles on the PO that also claim this name (copy / left).
  sharedWith: string[];
  reason: string | null;
};

export type MovePlanInput = {
  files: ApprovedLayoutsFile[];
  targetSubfolder: string;
  // The style's pinned subfolder before this run, when different from the target.
  previousSubfolder: string | null;
  // Lowercased sanitised name → the style's jobAssetId for that name, and
  // whether those bytes may be pushed (approved + print-safe, or the cover).
  ownNames: Map<string, { jobAssetId: string; pushable: boolean }>;
  // Lowercased sanitised name → the sibling styles (display names) claiming it.
  siblingNames: Map<string, string[]>;
  // Graph item ids of this style's manually supplied documents.
  manualItemIds: Set<string>;
};

const nameKey = (name: string) => sanitizeFileName(name).toLowerCase();
const sameFolder = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Decide, per file, what happens to it. Pure: the listing and the attribution
// come in as data.
export function planStyleFolderMove(input: MovePlanInput): MovePlanItem[] {
  const inTarget = new Set(
    input.files
      .filter((f) => f.subfolder && sameFolder(f.subfolder.name, input.targetSubfolder))
      .map((f) => nameKey(f.name)),
  );

  const plan: MovePlanItem[] = [];
  for (const f of input.files) {
    const k = nameKey(f.name);
    const base = {
      itemId: f.id,
      fileName: f.name,
      from: f.subfolder ? `${APPROVED_LAYOUTS_SUBFOLDER}/${f.subfolder.name}` : APPROVED_LAYOUTS_SUBFOLDER,
      jobAssetId: null,
      sharedWith: [] as string[],
      reason: null,
    };

    if (f.subfolder) {
      // Already home.
      if (sameFolder(f.subfolder.name, input.targetSubfolder)) continue;
      // The style's own previous folder (colour corrected since): everything in
      // it is this style's by construction, so all of it comes along.
      if (input.previousSubfolder && sameFolder(f.subfolder.name, input.previousSubfolder)) {
        plan.push({ ...base, action: inTarget.has(k) ? "remove-duplicate" : "move" });
        continue;
      }
      // Some other style's folder — never ours to touch.
      continue;
    }

    // Flat file, one of our manual uploads: the stored item id proves it.
    if (input.manualItemIds.has(f.id)) {
      plan.push({ ...base, action: inTarget.has(k) ? "remove-duplicate" : "move" });
      continue;
    }

    const own = input.ownNames.get(k);
    if (!own) continue; // not this style's — not listed

    const sharedWith = input.siblingNames.get(k) ?? [];
    if (sharedWith.length > 0) {
      if (inTarget.has(k)) {
        // This style's own copy is already in its folder; the flat one stays
        // for the sibling. Nothing to do, but worth saying why it remains.
        plan.push({
          ...base,
          action: "left",
          jobAssetId: own.jobAssetId,
          sharedWith,
          reason: "this style's own copy is already in its folder; the flat file stays for the other style(s) using the same name",
        });
      } else if (own.pushable) {
        plan.push({ ...base, action: "copy", jobAssetId: own.jobAssetId, sharedWith });
      } else {
        plan.push({
          ...base,
          action: "left",
          jobAssetId: own.jobAssetId,
          sharedWith,
          reason: "the name is shared with another style and this style's version isn't approved, so there are no bytes to copy",
        });
      }
      continue;
    }

    plan.push({ ...base, action: inTarget.has(k) ? "remove-duplicate" : "move", jobAssetId: own.jobAssetId });
  }

  const rank: Record<MoveAction, number> = { move: 0, "remove-duplicate": 1, copy: 2, left: 3 };
  return plan.sort((a, b) => rank[a.action] - rank[b.action] || a.fileName.localeCompare(b.fileName));
}

// -----------------------------------------------------
// Graph + DB shell
// -----------------------------------------------------

export type MoveOutcome = MovePlanItem & {
  done: boolean;
  // Why an apply didn't do what the plan said (403, vanished file, …).
  error: string | null;
};

export type MoveToStyleFolderResult = {
  dryRun: boolean;
  styleId: string;
  subfolderName: string;
  previousSubfolderName: string | null;
  // "<PO folder> / APPROVED LAYOUTS / <subfolder>"
  folderPath: string;
  folderUrl: string | null;
  items: MoveOutcome[];
  // The old subfolder was emptied and removed (colour-correction re-home).
  previousFolderRemoved: boolean;
  counts: { moved: number; duplicatesRemoved: number; copied: number; left: number; failed: number };
};

export class MoveToStyleFolderError extends Error {
  constructor(
    public readonly httpStatus: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "MoveToStyleFolderError";
  }
}

// Every name a style's current outputs answer to — the stamp and, best-effort,
// the layout's current template — mapped to the asset behind it.
async function loadOwnedNames(
  styleId: string,
): Promise<Map<string, { jobAssetId: string; pushable: boolean }>> {
  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  const { resolveCurrentFileNames } = await import("./current-file-names");
  const { COVER_VARIANT_KEY } = await import("@/lib/pdf/bundle-page-keys");

  const outputs = (await getCurrentOutputsForStyle(styleId)).filter(
    (o) => o.jobAssetId != null && o.fileName != null,
  );
  let current: Awaited<ReturnType<typeof resolveCurrentFileNames>> = new Map();
  try {
    current = await resolveCurrentFileNames(
      styleId,
      outputs.map((o) => ({ jobAssetId: o.jobAssetId as string, variantKey: o.variantKey })),
      { variantsAlreadyFresh: true },
    );
  } catch (err) {
    // Without template answers every document still answers to its stamp.
    console.warn(`[style-folder-move] current-name resolution failed for style ${styleId}:`, err);
  }

  const out = new Map<string, { jobAssetId: string; pushable: boolean }>();
  for (const o of outputs) {
    const jobAssetId = o.jobAssetId as string;
    // The same gate push-to-supplier applies: approved + print-safe, or the cover.
    const pushable =
      o.placeholderCount === 0 && (o.reviewStatus === "APPROVED" || o.variantKey === COVER_VARIANT_KEY);
    const entry = { jobAssetId, pushable };
    out.set(nameKey(o.fileName as string), entry);
    const r = current.get(jobAssetId);
    if (r?.kind === "resolved") out.set(nameKey(r.fileName), entry);
  }
  return out;
}

export async function moveStyleIntoSubfolder(input: {
  styleId: string;
  dryRun: boolean;
  userId?: string;
}): Promise<MoveToStyleFolderResult> {
  const { db } = await import("@/lib/db");
  const { parseCustomerConfig } = await import("@/lib/customers/config");
  const { isGraphConfigured } = await import("./auth");
  const { resolveApprovedLayoutsFolder, reconcileStateMessage } = await import("./reconcile-folder");
  const { computeStyleSubfolderName, ensureStyleDeliveryFolder } = await import("./style-subfolder");
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  const {
    listApprovedLayoutsFiles,
    listChildFiles,
    findChildFolder,
    moveDriveItem,
    deleteDriveItem,
    uploadIntoFolder,
    SharePointWriteForbiddenError,
  } = await import("./supplier-folder");

  const style = await db.style.findUnique({
    where: { id: input.styleId },
    select: {
      id: true,
      name: true,
      poNumber: true,
      supplierId: true,
      supplierPoFolderName: true,
      supplierSubfolderName: true,
      customer: { select: { config: true } },
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  if (!style) throw new MoveToStyleFolderError(404, "Style not found");
  if (!isGraphConfigured()) {
    throw new MoveToStyleFolderError(409, "SharePoint isn't configured on this server.");
  }
  const skipSupplierDelivery = parseCustomerConfig(style.customer.config).skipSupplierDelivery;
  if (skipSupplierDelivery) {
    throw new MoveToStyleFolderError(409, "This customer delivers its own goods — nothing is sent to a supplier folder.");
  }

  // The same folder chain the push, verify and reconcile use.
  const target = await resolveApprovedLayoutsFolder({
    id: style.id,
    name: style.name,
    poNumber: style.poNumber,
    supplierId: style.supplierId,
    supplierPoFolderName: style.supplierPoFolderName,
    supplierName: style.supplier?.name ?? null,
    supplierFolderUrl: style.supplier?.sharepointUrl ?? null,
    skipSupplierDelivery,
  });
  if (target.state === "subfolder-missing") {
    throw new MoveToStyleFolderError(
      409,
      `The PO folder has no “${APPROVED_LAYOUTS_SUBFOLDER}” folder yet, so nothing has been delivered to move.`,
    );
  }
  if (target.state !== "ok" || !target.driveId || !target.leafItemId) {
    throw new MoveToStyleFolderError(
      409,
      reconcileStateMessage(target.state, { supplierName: style.supplier?.name, poNumber: style.poNumber }),
    );
  }
  const driveId = target.driveId;
  const leafItemId = target.leafItemId;

  const subfolderName = await computeStyleSubfolderName(style.id);
  if (!subfolderName) throw new MoveToStyleFolderError(404, "Style not found");
  const pinned = style.supplierSubfolderName?.trim() || null;
  const previousSubfolder = pinned && !sameFolder(pinned, subfolderName) ? pinned : null;

  // Attribution: this style's names, every sibling's names, our manual uploads.
  await ensureLayoutVariantsLoaded(true);
  const ownNames = await loadOwnedNames(style.id);
  const siblings =
    style.poNumber && style.supplierId
      ? await db.style.findMany({
          where: {
            id: { not: style.id },
            poNumber: style.poNumber,
            supplierId: style.supplierId,
            archivedAt: null,
            deletedAt: null,
          },
          select: { id: true, name: true },
        })
      : [];
  const siblingNames = new Map<string, string[]>();
  for (const sib of siblings) {
    let names: Map<string, unknown>;
    try {
      names = await loadOwnedNames(sib.id);
    } catch (err) {
      // A sibling we can't read might claim any name — refuse rather than risk
      // moving its only copy of something.
      console.warn(`[style-folder-move] sibling ${sib.id} names failed:`, err);
      throw new MoveToStyleFolderError(
        409,
        `Couldn't work out which files belong to “${sib.name}”, another style on this PO — try again in a moment.`,
      );
    }
    for (const k of names.keys()) {
      const arr = siblingNames.get(k) ?? [];
      if (!arr.includes(sib.name)) arr.push(sib.name);
      siblingNames.set(k, arr);
    }
  }
  const manualRows = await db.styleManualTrimUpload.findMany({
    where: { styleId: style.id, sharepointItemId: { not: null } },
    select: { id: true, sharepointItemId: true },
  });
  const manualItemIds = new Set(manualRows.map((r) => r.sharepointItemId as string));

  let files: ApprovedLayoutsFile[];
  try {
    files = await listApprovedLayoutsFiles(driveId, leafItemId);
  } catch (err) {
    if (err instanceof SharePointWriteForbiddenError) throw new MoveToStyleFolderError(403, err.message);
    throw err;
  }

  const plan = planStyleFolderMove({
    files,
    targetSubfolder: subfolderName,
    previousSubfolder,
    ownNames,
    siblingNames,
    manualItemIds,
  });

  const folderPath = `${target.poFolderName ?? "PO folder"} / ${APPROVED_LAYOUTS_SUBFOLDER} / ${subfolderName}`;
  const summarize = (items: MoveOutcome[]) => ({
    moved: items.filter((i) => i.action === "move" && i.done).length,
    duplicatesRemoved: items.filter((i) => i.action === "remove-duplicate" && i.done).length,
    copied: items.filter((i) => i.action === "copy" && i.done).length,
    left: items.filter((i) => i.action === "left").length,
    failed: items.filter((i) => i.action !== "left" && !i.done).length,
  });

  if (input.dryRun) {
    const existing = await findChildFolder(driveId, leafItemId, subfolderName).catch(() => null);
    const items = plan.map((p) => ({ ...p, done: false, error: null }));
    return {
      dryRun: true,
      styleId: style.id,
      subfolderName,
      previousSubfolderName: previousSubfolder,
      folderPath,
      folderUrl: existing?.webUrl ?? null,
      items,
      previousFolderRemoved: false,
      counts: {
        // Planned, not done — the preview reads these as "will".
        moved: plan.filter((i) => i.action === "move").length,
        duplicatesRemoved: plan.filter((i) => i.action === "remove-duplicate").length,
        copied: plan.filter((i) => i.action === "copy").length,
        left: plan.filter((i) => i.action === "left").length,
        failed: 0,
      },
    };
  }

  // ---- Apply. Create (and pin) the style's folder first: from here on every
  // push for this style lands there, whatever this run manages to move.
  let folder: { id: string; webUrl: string | null };
  try {
    folder = await ensureStyleDeliveryFolder({
      driveId,
      approvedLayoutsItemId: leafItemId,
      styleId: style.id,
      subfolderName,
    });
  } catch (err) {
    if (err instanceof SharePointWriteForbiddenError) throw new MoveToStyleFolderError(403, err.message);
    throw err;
  }

  const errorText = (err: unknown) =>
    err instanceof SharePointWriteForbiddenError
      ? "SharePoint refused the change (403)"
      : `${(err as Error).message}`.slice(0, 120);

  const newUrlByItem = new Map<string, string | null>();
  const newUrlByAsset = new Map<string, string | null>();
  const items: MoveOutcome[] = [];
  for (const p of plan) {
    const outcome: MoveOutcome = { ...p, done: false, error: null };
    try {
      if (p.action === "move") {
        const res = await moveDriveItem(driveId, p.itemId, folder.id);
        if (res.moved) {
          outcome.done = true;
          newUrlByItem.set(p.itemId, res.webUrl ?? null);
          if (p.jobAssetId) newUrlByAsset.set(p.jobAssetId, res.webUrl ?? null);
        } else if (res.conflict) {
          // A copy under the same name reached the folder since the plan was
          // made (a push). That copy is the newer one; the flat file is the
          // duplicate — but only delete it once we've seen the other is there.
          const other = (await listChildFiles(driveId, folder.id)).find((f) => nameKey(f.name) === nameKey(p.fileName));
          if (other) {
            const del = await deleteDriveItem(driveId, p.itemId);
            outcome.done = del.deleted || del.alreadyGone;
            outcome.action = "remove-duplicate";
          } else {
            outcome.error = "a file with this name appeared in the style's folder — re-check and try again";
          }
        } else if (res.notFound) {
          outcome.error = "the file was no longer there";
        }
      } else if (p.action === "remove-duplicate") {
        // Re-confirm the copy we'd be keeping is really in the style's folder.
        const other = (await listChildFiles(driveId, folder.id)).find((f) => nameKey(f.name) === nameKey(p.fileName));
        if (!other) {
          outcome.error = "the copy in the style's folder is gone — nothing was deleted";
        } else {
          const del = await deleteDriveItem(driveId, p.itemId);
          outcome.done = del.deleted || del.alreadyGone;
        }
      } else if (p.action === "copy" && p.jobAssetId) {
        const asset = await db.jobAsset.findUnique({
          where: { id: p.jobAssetId },
          select: { pdf: true },
        });
        if (!asset) {
          outcome.error = "the approved output is gone — nothing was copied";
        } else {
          const up = await uploadIntoFolder(driveId, folder.id, sanitizeFileName(p.fileName), Buffer.from(asset.pdf));
          outcome.done = true;
          newUrlByAsset.set(p.jobAssetId, up.webUrl);
        }
      }
    } catch (err) {
      outcome.error = errorText(err);
    }
    items.push(outcome);
  }

  // Re-home: remove the previous subfolder once nothing is left in it. Only a
  // folder that is provably empty goes — anything a person put there stays.
  let previousFolderRemoved = false;
  if (previousSubfolder) {
    try {
      // Re-read AFTER the moves: childCount counts files and folders alike, so
      // zero means genuinely empty.
      const old = await findChildFolder(driveId, leafItemId, previousSubfolder);
      if (old && old.childCount === 0) {
        const del = await deleteDriveItem(driveId, old.id);
        previousFolderRemoved = del.deleted || del.alreadyGone;
      }
    } catch (err) {
      console.warn(`[style-folder-move] could not remove old subfolder “${previousSubfolder}”:`, err);
    }
  }

  // ---- Bring the database in line with where the files now are.
  await db.style
    .update({ where: { id: style.id }, data: { supplierFolderUrl: folder.webUrl } })
    .catch(() => {});
  // Queue rows deep-link the folder they were delivered to; point them at the
  // style's folder and let verify re-confirm on its next pass (it lists both
  // layouts, so a moved file reads present, never missing).
  await db.supplierSendQueueItem
    .updateMany({
      where: { styleId: style.id, sharePointStatus: "UPLOADED" },
      data: { sharePointFolderUrl: folder.webUrl, sharePointVerifiedAt: null },
    })
    .catch(() => {});
  for (const [assetId, url] of newUrlByAsset) {
    if (!url) continue;
    await db.supplierSendQueueItem
      .updateMany({ where: { styleId: style.id, jobAssetId: assetId }, data: { sharePointUrl: url } })
      .catch(() => {});
  }
  // A manual document keeps its item id when moved; only its link changes.
  for (const row of manualRows) {
    const url = newUrlByItem.get(row.sharepointItemId as string);
    if (url === undefined) continue;
    await db.styleManualTrimUpload
      .update({ where: { id: row.id }, data: { sharepointWebUrl: url } })
      .catch(() => {});
  }

  const counts = summarize(items);
  try {
    const job = await db.job.findFirst({
      where: { styleId: style.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await db.log.create({
      data: {
        jobId: job?.id ?? null,
        level: "INFO",
        message:
          `moved into style folder · ${folderPath} · moved ${counts.moved}, removed ${counts.duplicatesRemoved} duplicate(s), copied ${counts.copied}` +
          (counts.left > 0 ? `, left ${counts.left} shared file(s)` : "") +
          (counts.failed > 0 ? `, ${counts.failed} failed` : "") +
          (previousSubfolder ? ` · from “${previousSubfolder}”${previousFolderRemoved ? " (removed)" : ""}` : "") +
          (input.userId ? ` · by user ${input.userId}` : ""),
        payload: { subfolderName, previousSubfolder, items, byUserId: input.userId ?? null },
      },
    });
  } catch {
    /* best-effort */
  }

  return {
    dryRun: false,
    styleId: style.id,
    subfolderName,
    previousSubfolderName: previousSubfolder,
    folderPath,
    folderUrl: folder.webUrl,
    items,
    previousFolderRemoved,
    counts,
  };
}
