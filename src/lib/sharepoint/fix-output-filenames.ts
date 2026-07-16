import { db } from "@/lib/db";
import type { StyleData } from "@/lib/pdf/types";
import { getVariant } from "@/lib/pdf/template-registry";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { getSharedItem } from "./shares";
import {
  sanitizeFileName,
  resolveSupplierFolder,
  listChildFolders,
  resolvePoFolder,
  findChildFolder,
  findChildFile,
  renameDriveItem,
  deleteDriveItem,
  SharePointWriteForbiddenError,
} from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";

// =====================================================
// "Fix output filenames" (manual, from /settings/approved). An output is named
// once — at generation — from its layout's fileName template, and stored on
// JobAsset.fileName; the supplier push uploads under that stored name. So when a
// template is edited AFTER the output was approved + uploaded, the SharePoint
// file (and our stored name) keep the OLD name — the runner won't regenerate an
// approved output, so the new name never lands.
//
// This sweep reconciles every UPLOADED supplier output against what its layout's
// CURRENT template says it should be called, and for each mismatch:
//   • renames the SharePoint file IN PLACE (Graph PATCH — no re-upload, no
//     re-review, the approval is untouched), and
//   • corrects the stored JobAsset.fileName + the queue row's sharePointUrl, so
//     the drift doesn't reappear on the next push/verify (both read the stored
//     name).
// Rename-in-place is the happy path; if the correctly-named file already exists
// in the folder, the stale one is deleted instead. dryRun computes the plan
// (old → new per file) touching neither SharePoint nor the DB.
// =====================================================

export type FixAction = "rename" | "delete-stale" | "ok" | "skip" | "failed";

export type FixItem = {
  styleId: string;
  styleName: string;
  variantKey: string;
  docType: string;
  currentName: string; // what the file is called on SharePoint now (sanitised)
  correctName: string; // what the template says it should be (sanitised)
  action: FixAction;
  note?: string;
};

export type FixResult = {
  scanned: number; // UPLOADED rows examined
  needFix: number; // rows whose name differs from the template
  renamed: number; // files renamed in place (apply only)
  deletedStale: number; // stale duplicates removed because the correct name already existed
  alreadyCorrect: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  items: FixItem[]; // rows needing a change (+ any skip/fail), not the already-correct ones
};

type Row = {
  id: string;
  styleId: string;
  variantKey: string;
  jobAssetId: string | null;
  docType: string;
  sharePointFolderUrl: string | null;
};

type StyleMeta = {
  id: string;
  name: string;
  poNumber: string | null;
  supplierPoFolderName: string | null;
  supplierUrl: string | null;
};

// A row needing a rename, carrying the resolved names so apply doesn't recompute.
type Planned = {
  row: Row;
  correctStored: string; // the un-sanitised template result → JobAsset.fileName
  currentSp: string; // sanitizeFileName(stored) — the on-SharePoint name
  correctSp: string; // sanitizeFileName(correct) — the target name
};

const DEFAULT_LIMIT = 3000;

type NameResult = { name: string } | { skip: string } | null;

// The suffix (<size>[-<colour>]) baked into a leaked default filename —
// "<style>-layout-<id>-<suffix>.pdf" / "…layout:<id>…". Lets us recover which
// split row a file is for when the queue row carries only the base variant key
// (the runner drops the "#suffix" when a split produced a single document).
function suffixFromStored(stored: string, layoutId: string): string | null {
  const m = stored.match(new RegExp(`layout[-:]${layoutId}-(.+)\\.pdf$`, "i"));
  return m ? m[1] : null;
}

// The filename the layout's CURRENT template produces for one file. CRITICAL:
// for a per-size (split) output we resolve the name for the SPECIFIC size/colour
// this file represents — matched via the split plan's suffix — never the whole
// style (which would pick the first size and mislabel the file). When the file
// can't be mapped to a current split row (its size/colour is gone, or the queue
// row can't be tied to one row), we SKIP rather than guess.
//   { name }  → the correct name for this exact file
//   { skip }  → surfaced as skipped, with a reason
//   null      → genuine no-op (empty template / variant unavailable)
function correctNameForRow(row: Row, styleData: StyleData, stored: string): NameResult {
  const [baseKey, hashSuffix] = row.variantKey.split("#");
  const variant = getVariant(baseKey);
  if (!variant) {
    // Framing pages (__cover__ etc.) and other non-layout keys are never
    // renamed — a genuine no-op, not a skip worth surfacing.
    return baseKey.startsWith("layout:") ? { skip: "layout variant not loaded (unpublished?)" } : null;
  }

  const plan = variant.filesPreview?.(styleData);
  if (!plan) {
    // Coded variant without a split preview — single file for the whole style.
    const n = variant.fileNameFor?.(styleData);
    return n ? { name: n } : null;
  }
  // Genuinely non-split: one document for the whole style.
  if (plan.length === 1 && plan[0].suffix === null) {
    return plan[0].fileName ? { name: plan[0].fileName } : null;
  }

  // Split output — map THIS file to its split row so the size/colour is kept.
  // Prefer an exact suffix (from the variant key, else recovered from the leaked
  // "layout:<id>-<suffix>" name).
  let suffix = hashSuffix || null;
  if (!suffix) {
    const layoutId = layoutIdFromVariantKey(baseKey);
    suffix = layoutId ? suffixFromStored(stored, layoutId) : null;
  }
  if (suffix) {
    const hit = plan.find((p) => p.suffix != null && p.suffix.toLowerCase() === suffix!.toLowerCase());
    if (!hit) return { skip: `size/colour "${suffix}" no longer in the style — regenerate` };
    return hit.fileName ? { name: hit.fileName } : null;
  }

  // No exact suffix (base variant key + a non-leaked name like
  // "00077180-L-Inner-Pack.pdf"). Identify the split row by matching its SIZE
  // (then colour, to disambiguate) as WHOLE tokens in the stored name — the size
  // is preserved by construction (we pick the row whose size the name already
  // carries), so this can't mislabel; ambiguous/no match → skip.
  const tokens = new Set(stored.toLowerCase().replace(/\.pdf$/i, "").split(/[^a-z0-9]+/i).filter(Boolean));
  const splits = plan.filter((p) => p.suffix != null);
  const bySize = splits.filter((p) => {
    const sizePart = p.suffix!.split("-")[0].toLowerCase();
    return sizePart.length > 0 && tokens.has(sizePart);
  });
  if (bySize.length === 1) return bySize[0].fileName ? { name: bySize[0].fileName } : null;
  if (bySize.length > 1) {
    const byBoth = bySize.filter((p) =>
      p.suffix!
        .toLowerCase()
        .split("-")
        .every((part) => part.length === 0 || tokens.has(part)),
    );
    if (byBoth.length === 1) return byBoth[0].fileName ? { name: byBoth[0].fileName } : null;
    return { skip: "several sizes/colours match this name — regenerate to disambiguate" };
  }
  return { skip: "per-size output — can't tie this file to one size" };
}

export async function fixOutputFileNames(opts?: {
  dryRun?: boolean;
  styleIds?: string[];
  limit?: number;
}): Promise<FixResult> {
  const dryRun = opts?.dryRun ?? false;
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  await ensureLayoutVariantsLoaded(true); // force-fresh so a just-saved template is used

  const rows: Row[] = await db.supplierSendQueueItem.findMany({
    where: {
      sharePointStatus: "UPLOADED",
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { styleId: { in: opts.styleIds } } : {}),
    },
    select: { id: true, styleId: true, variantKey: true, jobAssetId: true, docType: true, sharePointFolderUrl: true },
    orderBy: { queuedAt: "desc" },
    take: limit,
  });

  const result: FixResult = {
    scanned: rows.length,
    needFix: 0,
    renamed: 0,
    deletedStale: 0,
    alreadyCorrect: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    items: [],
  };
  if (rows.length === 0) return result;

  // Stored asset names (what the file is actually called on SharePoint).
  const assetIds = rows.map((r) => r.jobAssetId).filter((x): x is string => x != null);
  const assets = await db.jobAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, fileName: true } });
  const storedName = new Map(assets.map((a) => [a.id, a.fileName]));

  // Per-style folder-resolution metadata.
  const styleIds = [...new Set(rows.map((r) => r.styleId))];
  const styleRows = await db.style.findMany({
    where: { id: { in: styleIds } },
    select: { id: true, name: true, poNumber: true, supplierPoFolderName: true, supplier: { select: { sharepointUrl: true } } },
  });
  const styleMeta = new Map<string, StyleMeta>(
    styleRows.map((s) => [s.id, { id: s.id, name: s.name, poNumber: s.poNumber, supplierPoFolderName: s.supplierPoFolderName, supplierUrl: s.supplier?.sharepointUrl ?? null }]),
  );

  // ---- Plan: group by style, build StyleData once, diff each row's name.
  const byStyle = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byStyle.get(r.styleId) ?? [];
    arr.push(r);
    byStyle.set(r.styleId, arr);
  }

  const planned: Planned[] = [];
  for (const [styleId, styleRowsForStyle] of byStyle) {
    const meta = styleMeta.get(styleId);
    const styleName = meta?.name ?? styleId;
    let ctx;
    try {
      ctx = await loadStyleRenderContext(styleId);
    } catch (err) {
      for (const row of styleRowsForStyle)
        pushItem(result, row, styleName, "?", "?", "skip", `could not load style data: ${(err as Error).message.slice(0, 60)}`);
      result.skipped += styleRowsForStyle.length;
      continue;
    }
    if (!ctx) {
      for (const row of styleRowsForStyle) pushItem(result, row, styleName, "?", "?", "skip", "style not found");
      result.skipped += styleRowsForStyle.length;
      continue;
    }
    for (const row of styleRowsForStyle) {
      const stored = row.jobAssetId ? storedName.get(row.jobAssetId) : undefined;
      if (!stored) {
        pushItem(result, row, styleName, "?", "?", "skip", "no stored asset filename");
        result.skipped += 1;
        continue;
      }
      const res = correctNameForRow(row, ctx.styleData, stored);
      if (!res) continue; // genuine no-op (empty template / no split match to make)
      if ("skip" in res) {
        pushItem(result, row, styleName, sanitizeFileName(stored), "—", "skip", res.skip);
        result.skipped += 1;
        continue;
      }
      const correct = res.name;
      const currentSp = sanitizeFileName(stored);
      const correctSp = sanitizeFileName(correct);
      if (currentSp.toLowerCase() === correctSp.toLowerCase()) {
        result.alreadyCorrect += 1;
        continue;
      }
      result.needFix += 1;
      planned.push({ row, correctStored: correct, currentSp, correctSp });
      pushItem(result, row, styleName, currentSp, correctSp, "rename");
    }
  }

  if (dryRun || planned.length === 0) return result;

  // ---- Apply: rename in place (or delete the stale duplicate), then fix the DB.
  const folderCache = new Map<string, { driveId: string; itemId: string } | null>();

  for (const p of planned) {
    const item = result.items.find((i) => i.styleId === p.row.styleId && i.variantKey === p.row.variantKey);
    try {
      const folder = await resolveFolder(p.row, styleMeta.get(p.row.styleId), folderCache);
      if (!folder) {
        setItem(item, "skip", "could not resolve the SharePoint folder");
        result.skipped += 1;
        result.needFix -= 1;
        continue;
      }

      const existingCorrect = await findChildFile(folder.driveId, folder.itemId, p.correctSp);
      const existingStale = await findChildFile(folder.driveId, folder.itemId, p.currentSp);

      if (existingCorrect) {
        // The correctly-named file is already here. Remove the stale duplicate
        // (if present) and just fix our records.
        if (existingStale) {
          await deleteDriveItem(folder.driveId, existingStale.id);
          result.deletedStale += 1;
          setItem(item, "delete-stale", `correct file already present — removed stale "${p.currentSp}"`);
        } else {
          result.alreadyCorrect += 1;
          result.needFix -= 1;
          setItem(item, "ok", "already correct on SharePoint");
        }
        await writeBack(p, existingCorrect.webUrl ?? null);
        continue;
      }

      if (!existingStale) {
        setItem(item, "skip", "file not found in folder (moved or already cleaned)");
        result.skipped += 1;
        result.needFix -= 1;
        continue;
      }

      const res = await renameDriveItem(folder.driveId, existingStale.id, p.correctSp);
      if (res.renamed) {
        result.renamed += 1;
        setItem(item, "rename", "renamed in place");
        await writeBack(p, res.webUrl ?? null);
      } else if (res.conflict) {
        // Someone/thing created the target name in between — drop the stale one.
        await deleteDriveItem(folder.driveId, existingStale.id);
        result.deletedStale += 1;
        setItem(item, "delete-stale", "target name appeared concurrently — removed stale");
        await writeBack(p, null);
      } else {
        setItem(item, "skip", "file vanished before rename");
        result.skipped += 1;
        result.needFix -= 1;
      }
    } catch (err) {
      const msg = err instanceof SharePointWriteForbiddenError ? "SharePoint write not granted (403)" : (err as Error).message.slice(0, 80);
      setItem(item, "failed", msg);
      result.failed += 1;
      result.needFix -= 1;
    }
  }

  return result;
}

// Correct our own records so the next push/verify agrees with SharePoint.
async function writeBack(p: Planned, newWebUrl: string | null): Promise<void> {
  if (p.row.jobAssetId) {
    await db.jobAsset.update({ where: { id: p.row.jobAssetId }, data: { fileName: p.correctStored } }).catch(() => {});
  }
  await db.supplierSendQueueItem
    .update({ where: { id: p.row.id }, data: newWebUrl ? { sharePointUrl: newWebUrl } : {} })
    .catch(() => {});
}

// Resolve the APPROVED LAYOUTS folder (driveId + itemId) for a row: the stored
// folder URL is the fast path; if it's stale (folder renamed), fall back to the
// PO search the push/verify use. Cached per style.
async function resolveFolder(
  row: Row,
  meta: StyleMeta | undefined,
  cache: Map<string, { driveId: string; itemId: string } | null>,
): Promise<{ driveId: string; itemId: string } | null> {
  if (cache.has(row.styleId)) return cache.get(row.styleId) ?? null;
  let resolved: { driveId: string; itemId: string } | null = null;

  if (row.sharePointFolderUrl) {
    try {
      const item = await getSharedItem(row.sharePointFolderUrl);
      const driveId = item.parentReference?.driveId;
      if (driveId && item.id && item.folder) resolved = { driveId, itemId: item.id };
    } catch {
      /* stale — fall through to PO search */
    }
  }

  if (!resolved && meta?.supplierUrl && meta.poNumber) {
    try {
      const rootFolder = await resolveSupplierFolder(meta.supplierUrl);
      const children = await listChildFolders(rootFolder.driveId, rootFolder.itemId);
      const po = resolvePoFolder(children, meta.poNumber, meta.supplierPoFolderName);
      if (po.status === "found") {
        const leaf = await findChildFolder(rootFolder.driveId, po.folder.id, APPROVED_LAYOUTS_SUBFOLDER);
        if (leaf) resolved = { driveId: rootFolder.driveId, itemId: leaf.id };
      }
    } catch {
      resolved = null;
    }
  }

  cache.set(row.styleId, resolved);
  return resolved;
}

function pushItem(result: FixResult, row: Row, styleName: string, currentName: string, correctName: string, action: FixAction, note?: string): void {
  result.items.push({ styleId: row.styleId, styleName, variantKey: row.variantKey, docType: row.docType, currentName, correctName, action, note });
}

function setItem(item: FixItem | undefined, action: FixAction, note: string): void {
  if (item) {
    item.action = action;
    item.note = note;
  }
}
