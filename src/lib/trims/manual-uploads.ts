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
// Reads tolerate the table not being deployed yet (P2021). Railway runs
// `prisma migrate deploy` before start so this shouldn't happen, but a cover
// render is the last place that should hard-fail on a missing table — the
// pre-feature behaviour (nothing delivered) is a perfectly correct fallback.
// =====================================================

function isMissingTable(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2021";
}

// Normalised labels of this style's manual trims whose document is in the
// supplier's APPROVED LAYOUTS folder. Empty set ⇒ nothing delivered, which is
// exactly the pre-feature manifest.
export async function loadManualDeliveredLabels(styleId: string): Promise<Set<string>> {
  try {
    const rows = await db.styleManualTrimUpload.findMany({
      where: { styleId, NOT: { sharepointItemId: null } },
      select: { normalizedLabel: true },
    });
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
  originalName: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  delivered: boolean;
  webUrl: string | null;
  deliveredAt: string | null;
  uploadError: string | null;
  updatedAt: string;
};

export async function listManualTrimUploads(styleId: string): Promise<ManualTrimUploadSummary[]> {
  let rows;
  try {
    rows = await db.styleManualTrimUpload.findMany({
      where: { styleId },
      orderBy: { createdAt: "asc" },
      select: {
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
      },
    });
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }

  return rows.map((r) => ({
    id: r.id,
    trimLabel: r.trimLabel,
    normalizedLabel: r.normalizedLabel,
    originalName: r.originalName,
    fileName: r.fileName,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    delivered: r.sharepointItemId !== null,
    webUrl: r.sharepointWebUrl,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    uploadError: r.uploadError,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// Re-exported so callers building a lookup key never reach past this module
// into classify.ts and pick a different normalisation by accident.
export { normalizeTrimLabel };
