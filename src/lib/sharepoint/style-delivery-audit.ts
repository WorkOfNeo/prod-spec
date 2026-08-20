import { db } from "@/lib/db";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { isExpectedInSupplierFolder } from "@/lib/outputs/folder-expected";
import {
  resolveSupplierFolder,
  findChildFolder,
  listChildFileNames,
  listChildFolders,
  resolvePoFolder,
  sanitizeFileName,
} from "./supplier-folder";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";

// =====================================================
// Per-style delivery audit — "are all of this style's approved PDFs actually
// in the supplier's folder?", answered by DOCUMENT, not by queue row.
//
// Why this exists. Every other surface counts SLOTS: the supplier-send queue
// holds one row per output slot (base variantKey), and a slot holding three
// split documents is ONE row. So a style whose three carton documents all
// resolve to the SAME file name pushes three PUTs to one name, keeps one file,
// and still reports "1 of 1 uploaded ✓" — the row is honestly UPLOADED, the
// folder is honestly short, and no counter compares the two.
//
// The self-heal verify (verify-supplier-uploads.ts) misses it for the same
// reason from the other side: it asks `expected.every(n => names.has(n))`
// against a Set, so N identical expected names are satisfied by ONE file.
//
// This module expands slots to documents and reconciles three lists:
//
//   expected  — every document the push would write, with the SANITISED name
//               it writes under (what SharePoint actually keys on).
//   present   — the real folder listing.
//   collided  — expected documents sharing one sanitised name. These are NOT
//               "missing": their name IS in the folder. They are unrecoverable
//               by re-uploading (the second PUT would overwrite the first
//               again), so they must never be re-armed — that would churn the
//               sweep forever. They need a file-name TEMPLATE fix.
//
// The missing/collided split is the load-bearing distinction here: missing is
// healable by a re-push, collided is not.
// =====================================================

export type AuditDoc = {
  variantKey: string; // full key incl. "#suffix" for a split document
  baseKey: string; // the slot the queue row is keyed on
  docType: string;
  name: string; // display name, e.g. "… Carton Marking · 8R-Mix"
  fileName: string; // JobAsset.fileName as stored
  spName: string; // sanitised + lowercased — the SharePoint key
  jobAssetId: string;
  layoutId: string | null;
};

export type AuditCollision = {
  spName: string;
  layoutId: string | null;
  docs: AuditDoc[];
  lost: number; // docs.length - 1 — how many never survive the push
};

// Slots that are approved + print-safe but have NO supplier-send queue row.
// reconcileSupplierSendQueue only backfills styles with ZERO rows, so a slot
// whose enqueue failed on a style that has other rows is covered by nothing.
export type AuditUnqueued = {
  baseKey: string;
  docType: string;
  name: string;
};

export type DeliveryAuditStatus =
  | "ok" // every expected document is in the folder, no collisions
  | "gaps" // something is missing, collided, or unqueued
  | "no-supplier" // no supplier linked / no folder link on file
  | "no-folder" // PO folder not found under the supplier
  | "ambiguous" // several folders match the PO — a human must resolve
  | "nothing-queued" // no approved outputs captured for this style yet
  | "unresolved" // Graph error / permission — cannot conclude anything
  | "disabled"; // supplierBatchSendEnabled is OFF

export type StyleDeliveryAudit = {
  status: DeliveryAuditStatus;
  message: string;
  folderName: string | null;
  folderUrl: string | null;
  expectedDocs: number; // documents the push would write
  distinctNames: number; // distinct sanitised names among them
  deliveredDocs: number; // expected documents whose name is in the folder
  expected: AuditDoc[];
  missing: AuditDoc[]; // expected, name absent from the folder — re-push heals
  collisions: AuditCollision[]; // name present but N docs share it — needs a template fix
  stale: string[]; // in the folder, not expected — an earlier name, probably
  unqueued: AuditUnqueued[];
};

function emptyAudit(status: DeliveryAuditStatus, message: string): StyleDeliveryAudit {
  return {
    status,
    message,
    folderName: null,
    folderUrl: null,
    expectedDocs: 0,
    distinctNames: 0,
    deliveredDocs: 0,
    expected: [],
    missing: [],
    collisions: [],
    stale: [],
    unqueued: [],
  };
}

function baseKeyOf(variantKey: string, docType: string): string {
  return variantKey.split("#")[0] || `doc:${docType}`;
}

// The documents the push would write for this style, expanded exactly the way
// pushQueuedSupplierUploads expands them: each queue row → every current
// APPROVED + print-safe document of its slot, falling back to the stored
// representative when current-outputs can't resolve the slot (framing pages
// like the cover live on that fallback — they are delivered without being
// "approved", so the approved-only filter would drop them).
export async function collectExpectedDocs(styleId: string): Promise<{
  expected: AuditDoc[];
  unqueued: AuditUnqueued[];
}> {
  const rows = await db.supplierSendQueueItem.findMany({
    where: { styleId },
    select: { variantKey: true, jobAssetId: true, docType: true, displayName: true },
  });

  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
  let outputs: Awaited<ReturnType<typeof getCurrentOutputsForStyle>> = [];
  try {
    outputs = await getCurrentOutputsForStyle(styleId);
  } catch {
    // Fall through — the stored representatives below still describe the push.
  }

  // The shared "does this belong in the folder?" rule — approval PLUS the cover,
  // which ships unapproved by design (enqueueCoverForSupplier). The cover used
  // to reach the expected set only through the representative FALLBACK below,
  // which needs a supplier-send queue row to exist: a cover that was never
  // enqueued was simply absent from this check, and one that was enqueued
  // arrived without its docType or layout context and so never took part in the
  // collision grouping. Naming it here makes it an ordinary expected document.
  const approvedByBase = new Map<string, typeof outputs>();
  for (const o of outputs) {
    if (!isExpectedInSupplierFolder(o)) continue;
    const b = baseKeyOf(o.variantKey, o.docType);
    const arr = approvedByBase.get(b) ?? [];
    arr.push(o);
    approvedByBase.set(b, arr);
  }

  // Fallback names for representatives that current-outputs didn't resolve.
  const repIds = rows.map((r) => r.jobAssetId).filter((x): x is string => x != null);
  const repById = new Map<string, { fileName: string; docType: string }>();
  if (repIds.length > 0) {
    const assets = await db.jobAsset.findMany({
      where: { id: { in: repIds } },
      select: { id: true, fileName: true, docType: true },
    });
    for (const a of assets) repById.set(a.id, { fileName: a.fileName, docType: a.docType });
  }

  const expected: AuditDoc[] = [];
  const seenAsset = new Set<string>();
  const push = (d: AuditDoc) => {
    if (seenAsset.has(d.jobAssetId)) return;
    seenAsset.add(d.jobAssetId);
    expected.push(d);
  };

  for (const row of rows) {
    const docs = approvedByBase.get(row.variantKey);
    if (docs && docs.length > 0) {
      for (const o of docs) {
        if (!o.fileName || !o.jobAssetId) continue;
        push({
          variantKey: o.variantKey,
          baseKey: row.variantKey,
          docType: o.docType,
          name: o.name,
          fileName: o.fileName,
          spName: sanitizeFileName(o.fileName).toLowerCase(),
          jobAssetId: o.jobAssetId,
          layoutId: layoutIdFromVariantKey(row.variantKey),
        });
      }
      continue;
    }
    // Representative fallback (cover pages, slots current-outputs dropped).
    if (!row.jobAssetId) continue;
    const rep = repById.get(row.jobAssetId);
    if (!rep) continue;
    push({
      variantKey: row.variantKey,
      baseKey: row.variantKey,
      docType: rep.docType || row.docType,
      name: row.displayName ?? rep.fileName,
      fileName: rep.fileName,
      spName: sanitizeFileName(rep.fileName).toLowerCase(),
      jobAssetId: row.jobAssetId,
      layoutId: layoutIdFromVariantKey(row.variantKey),
    });
  }

  // Approved slots the queue never captured. Reported, not silently folded in:
  // they are a different failure (capture) from a missing file (delivery).
  const rowKeys = new Set(rows.map((r) => r.variantKey));
  const unqueued: AuditUnqueued[] = [];
  for (const [base, docs] of approvedByBase) {
    if (rowKeys.has(base)) continue;
    // Deliberately the NARROW approval rule, not isExpectedInSupplierFolder: an
    // un-queued cover is not a capture failure. enqueueCoverForSupplier has its
    // own preconditions (a linked supplier, a customer that isn't
    // self-delivering, and at least one real generated output), so a cover with
    // no queue row is usually correctly absent — reporting it here would be
    // noise on every style that has yet to generate an output.
    const allApproved = docs.every(
      (d) => d.reviewStatus === "APPROVED" && d.placeholderCount === 0 && d.state === "APPROVED",
    );
    if (!allApproved) continue;
    unqueued.push({ baseKey: base, docType: docs[0].docType, name: docs[0].name });
  }

  return { expected, unqueued };
}

// Group expected documents by the name they actually land under. Any group
// larger than one is a collision: the push writes them all, SharePoint keeps
// the last, and every earlier one is lost with no error anywhere.
export function findCollisions(expected: AuditDoc[]): AuditCollision[] {
  const byName = new Map<string, AuditDoc[]>();
  for (const d of expected) {
    const arr = byName.get(d.spName) ?? [];
    arr.push(d);
    byName.set(d.spName, arr);
  }
  const out: AuditCollision[] = [];
  for (const [spName, docs] of byName) {
    if (docs.length < 2) continue;
    out.push({
      spName,
      layoutId: docs.find((d) => d.layoutId)?.layoutId ?? null,
      docs,
      lost: docs.length - 1,
    });
  }
  return out.sort((a, b) => b.lost - a.lost);
}

// Full audit: expand documents, list the real folder, reconcile.
export async function auditStyleDelivery(styleId: string): Promise<StyleDeliveryAudit> {
  if (!(await getSupplierBatchSendEnabled())) {
    return emptyAudit("disabled", "Automatic supplier sending is OFF — nothing is pushed to SharePoint.");
  }

  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      poNumber: true,
      supplierPoFolderName: true,
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  if (!style) return emptyAudit("unresolved", "Style not found.");
  if (!style.supplier || !style.supplier.sharepointUrl?.trim()) {
    return emptyAudit(
      "no-supplier",
      style.supplier
        ? `Supplier “${style.supplier.name}” has no Supplier Folder link on the Monday Suppliers board.`
        : "No supplier is linked to this style on the Pre-Order board.",
    );
  }

  const { expected, unqueued } = await collectExpectedDocs(styleId);
  const collisions = findCollisions(expected);
  const distinctNames = new Set(expected.map((d) => d.spName)).size;

  if (expected.length === 0 && unqueued.length === 0) {
    return {
      ...emptyAudit("nothing-queued", "No approved outputs have been captured for delivery yet."),
      unqueued,
    };
  }

  // Resolve the folder exactly the way the push and the verify do, so the three
  // can never disagree about which folder is canonical.
  let names: Set<string>;
  let folderName: string | null = null;
  let folderUrl: string | null = null;
  try {
    const root = await resolveSupplierFolder(style.supplier.sharepointUrl.trim());
    if (!root) return emptyAudit("unresolved", "The supplier's SharePoint folder link could not be opened.");

    const children = await listChildFolders(root.driveId, root.itemId);
    const resolution = resolvePoFolder(children, style.poNumber, style.supplierPoFolderName);
    if (resolution.status === "ambiguous") {
      return emptyAudit(
        "ambiguous",
        `Several folders match PO ${style.poNumber ?? "—"} — pick one before delivery can be checked.`,
      );
    }
    if (resolution.status !== "found") {
      return {
        ...emptyAudit("no-folder", `No “${style.poNumber ?? "—"}” folder exists in the supplier's SharePoint.`),
        expectedDocs: expected.length,
        distinctNames,
        expected,
        collisions,
        unqueued,
      };
    }
    folderName = resolution.folder.name;

    const leaf = await findChildFolder(root.driveId, resolution.folder.id, APPROVED_LAYOUTS_SUBFOLDER);
    if (!leaf) {
      return {
        ...emptyAudit(
          "gaps",
          `The “${APPROVED_LAYOUTS_SUBFOLDER}” subfolder doesn't exist yet — nothing has been delivered.`,
        ),
        folderName,
        expectedDocs: expected.length,
        distinctNames,
        expected,
        missing: expected,
        collisions,
        unqueued,
      };
    }
    folderUrl = leaf.webUrl;
    names = await listChildFileNames(root.driveId, leaf.id);
  } catch (err) {
    // A 403 or network blip must never read as "the files are gone".
    return emptyAudit(
      "unresolved",
      `Couldn't read the supplier folder: ${(err as Error).message}`.slice(0, 300),
    );
  }

  const missing = expected.filter((d) => !names.has(d.spName));
  const expectedNames = new Set(expected.map((d) => d.spName));
  const stale = [...names].filter((n) => !expectedNames.has(n)).sort();

  // Only collisions whose name IS in the folder represent a loss: when the name
  // is absent every one of its documents is already counted under `missing`,
  // and adding the collision on top would double-count them.
  const missingNames = new Set(missing.map((d) => d.spName));
  const lost = collisions.filter((c) => !missingNames.has(c.spName)).reduce((n, c) => n + c.lost, 0);
  // A present colliding name means exactly ONE of its documents survived — so
  // "delivered" must subtract the overwritten ones, or the headline would claim
  // 7 of 7 delivered while the folder holds 5 files.
  const deliveredDocs = expected.length - missing.length - lost;
  const status: DeliveryAuditStatus =
    missing.length > 0 || collisions.length > 0 || unqueued.length > 0 ? "gaps" : "ok";

  const parts: string[] = [];
  if (collisions.length > 0) {
    parts.push(
      `${lost} document(s) can never be delivered — they share a file name with another document.`,
    );
  }
  if (missing.length > 0) parts.push(`${missing.length} file(s) missing from the folder.`);
  if (unqueued.length > 0) parts.push(`${unqueued.length} approved output(s) were never queued.`);

  return {
    status,
    message:
      status === "ok"
        ? `All ${expected.length} document(s) are in “${folderName}/${APPROVED_LAYOUTS_SUBFOLDER}”.`
        : parts.join(" "),
    folderName,
    folderUrl,
    expectedDocs: expected.length,
    distinctNames,
    deliveredDocs,
    expected,
    missing,
    collisions,
    stale,
    unqueued,
  };
}
