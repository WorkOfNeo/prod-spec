import { db } from "@/lib/db";
import { normalizeTrimLabel } from "./classify";

// =====================================================
// The DB side of manually-supplied trim documents.
//
// `manualDelivered` on TrimContext has existed since the trims manifest landed
// — a set of normalised labels whose file has been found in the order folder —
// but nothing ever populated it, so every manual row on every cover read as
// "Waiting for Customer Information" forever. This module is what fills it.
//
// DELIVERED MEANS IT REACHED SHAREPOINT, not "a file is stored". The bytes live
// in Postgres so an upload survives a folder that doesn't exist yet, but the
// cover is a promise to the supplier: it may only say "Approved" for a document
// the supplier's own folder actually holds. Hence sharepointItemId, not the
// row's mere existence, is the test.
//
// THERE ARE TWO WAYS A DOCUMENT GETS INTO THAT FOLDER, and the cover cannot
// tell them apart — nor should it. Either this app pushed it (sharepointItemId)
// or a person carried it across by hand and said so (manualApprovedAt). The
// second is not a weaker claim: for the lines that need it there is no app
// upload to wait for, and a cover that kept saying "Waiting for Customer
// Information" about a document already sitting in the supplier's folder is
// simply wrong. So the delivered set is the UNION, and every reader of it —
// the cover, the manifest fingerprint, the regen sweep — treats the two
// identically.
//
// Reads tolerate the schema not being deployed yet — the table missing (P2021)
// and, since hand-approval, the manualApprovedAt COLUMN missing (P2022).
// Railway runs `prisma migrate deploy` before start so production never sees
// either, but a dev server running this branch against the shared database does
// until `npm run db:deploy` is run by hand. A cover render and the reviewer's
// panel are the last two places that should hard-fail on that, so each read
// falls back to the answer it gave before the column existed.
//
// The fallback loses NOTHING: a hand-approval cannot exist while the column it
// would live in doesn't. Which is exactly why the fallback is the pre-feature
// query rather than an empty set — the app-pushed uploads are still real, and
// silently forgetting them would flip live covers back to "waiting".
// =====================================================

function isMissingTable(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2021";
}

// P2022: the table is there, one of the columns selected isn't.
function isMissingColumn(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2022";
}

// Normalised labels of this style's manual trims whose document is in the
// supplier's APPROVED LAYOUTS folder — pushed by this app OR put there by hand
// and confirmed. Empty set ⇒ nothing delivered, which is exactly the
// pre-feature manifest.
export async function loadManualDeliveredLabels(styleId: string): Promise<Set<string>> {
  const pushed = { NOT: { sharepointItemId: null } };
  const byHand = { NOT: { manualApprovedAt: null } };
  const select = { normalizedLabel: true } as const;

  try {
    const rows = await db.styleManualTrimUpload.findMany({
      where: { styleId, OR: [pushed, byHand] },
      select,
    });
    return new Set(rows.map((r) => r.normalizedLabel));
  } catch (err) {
    if (isMissingTable(err)) return new Set();
    if (!isMissingColumn(err)) throw err;
  }

  // Migration pending — ask the question the old column set can answer.
  try {
    const rows = await db.styleManualTrimUpload.findMany({ where: { styleId, ...pushed }, select });
    return new Set(rows.map((r) => r.normalizedLabel));
  } catch (err) {
    if (isMissingTable(err)) return new Set();
    throw err;
  }
}

// One stored upload, without the bytes — everything the panel and the API list
// need to describe the state of a manifest line.
export type ManualTrimUploadSummary = {
  id: string;
  trimLabel: string;
  normalizedLabel: string;
  // Null on a hand-approved row — there is no file here, only the statement
  // that the supplier's folder holds one.
  originalName: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  // Kept apart on purpose. `pushed` is what THIS APP did; `manuallyApproved` is
  // what a person said. `delivered` is the union — what the cover acts on — so
  // a caller asking "does the supplier have it?" reads one field, while the
  // panel, which must offer different buttons for the two, can still tell them
  // apart. Collapsing them into one boolean is how a hand-approved row would
  // end up offering "Open in SharePoint" for a link that doesn't exist.
  pushed: boolean;
  manuallyApproved: boolean;
  delivered: boolean;
  webUrl: string | null;
  deliveredAt: string | null;
  manualApprovedAt: string | null;
  uploadError: string | null;
  updatedAt: string;
};

// Everything the summary needs EXCEPT the hand-approval column, so the
// pre-migration retry can reuse it.
const BASE_SELECT = {
  id: true,
  trimLabel: true,
  normalizedLabel: true,
  originalName: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  sharepointItemId: true,
  sharepointWebUrl: true,
  deliveredAt: true,
  uploadError: true,
  updatedAt: true,
} as const;

// The row shape BASE_SELECT returns. manualApprovedAt is optional, which is
// what lets the same mapper serve both queries: absent on the pre-migration
// retry, present (possibly null) on the normal one.
type BaseRow = {
  id: string;
  trimLabel: string;
  normalizedLabel: string;
  originalName: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sharepointItemId: string | null;
  sharepointWebUrl: string | null;
  deliveredAt: Date | null;
  uploadError: string | null;
  updatedAt: Date;
  manualApprovedAt?: Date | null;
};

function toSummary(r: BaseRow): ManualTrimUploadSummary {
  const manualApprovedAt = r.manualApprovedAt ?? null;
  return {
    id: r.id,
    trimLabel: r.trimLabel,
    normalizedLabel: r.normalizedLabel,
    originalName: r.originalName,
    fileName: r.fileName,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    pushed: r.sharepointItemId !== null,
    manuallyApproved: manualApprovedAt !== null,
    delivered: r.sharepointItemId !== null || manualApprovedAt !== null,
    webUrl: r.sharepointWebUrl,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    manualApprovedAt: manualApprovedAt?.toISOString() ?? null,
    uploadError: r.uploadError,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listManualTrimUploads(styleId: string): Promise<ManualTrimUploadSummary[]> {
  const where = { styleId };
  const orderBy = { createdAt: "asc" } as const;

  try {
    const rows = await db.styleManualTrimUpload.findMany({
      where,
      orderBy,
      select: { ...BASE_SELECT, manualApprovedAt: true },
    });
    return rows.map(toSummary);
  } catch (err) {
    if (isMissingTable(err)) return [];
    if (!isMissingColumn(err)) throw err;
  }

  // Migration pending — every row reads as never hand-approved, which is the
  // truth: there is nowhere yet for such a statement to have been stored.
  try {
    const rows = await db.styleManualTrimUpload.findMany({ where, orderBy, select: BASE_SELECT });
    return rows.map(toSummary);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// Re-exported so callers building a lookup key never reach past this module
// into classify.ts and pick a different normalisation by accident.
export { normalizeTrimLabel };
