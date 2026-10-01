import { db } from "@/lib/db";
import { renderCartonCustomization } from "@/lib/output-layouts/carton-render";
import { MAX_SIBLING_SLOTS } from "@/lib/output-layouts/token-meta";
import { cartonGroupFileName } from "./file-name";

// Creating and removing a MULTI-STYLE CARTON GROUP — several styles from one PO
// that ship in one physical box and therefore need one shared carton marking.
//
// The render is NOT new work: it is the existing multi-style mechanism that
// /carton-prints and /carton-customize already drive (withSelectedSiblings →
// {{style2}}… + {{multipleStyles}}). What is new is that the pick is PERSISTED,
// so it survives, is reachable from every style in it, and its PDF flows
// through the normal approve → upload path as a real JobAsset.
//
// The carton barcode is whatever the MAIN style's {{cartonEan}} resolves to.
// Nothing is generated and nothing is copied — a stored copy could drift from
// the PO.

export type CreateGroupInput = {
  mainStyleId: string;
  /** The other styles on the box, in slot order. Must not include the main. */
  otherStyleIds: string[];
  variantKey: string;
  /** Carton numbering total; 1 when the marking doesn't print "1 of N". */
  totalCartons?: number | null;
  userId: string;
};

export type CreateGroupResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | { ok: true; groupId: string; jobId: string; fileName: string };

export async function createCartonGroup(
  input: CreateGroupInput,
): Promise<CreateGroupResult> {
  const otherIds = [...new Set(input.otherStyleIds.filter((id) => id !== input.mainStyleId))];

  if (otherIds.length === 0) {
    return { ok: false, status: 400, error: "Pick at least two styles for the carton" };
  }
  // Slot 1 is the main style, so the box holds MAX_SIBLING_SLOTS styles total.
  if (otherIds.length > MAX_SIBLING_SLOTS - 1) {
    return {
      ok: false,
      status: 400,
      error: `A carton marking can hold at most ${MAX_SIBLING_SLOTS} styles`,
    };
  }

  const main = await db.style.findUnique({
    where: { id: input.mainStyleId },
    select: { id: true, customerId: true, poNumber: true, prodSpecId: true },
  });
  if (!main) return { ok: false, status: 404, error: "Main style not found" };
  if (!main.poNumber) {
    return { ok: false, status: 400, error: "The main style has no PO number" };
  }

  // Every member must be a live style on the SAME PO — that is exactly the pool
  // the renderer will look in (loadSiblingStyles filters on poNumber), so a
  // style from elsewhere would silently render as an empty slot.
  const others = await db.style.findMany({
    where: { id: { in: otherIds }, archivedAt: null, deletedAt: null },
    select: { id: true, poNumber: true },
  });
  if (others.length !== otherIds.length) {
    return { ok: false, status: 404, error: "One or more of the picked styles no longer exists" };
  }
  const offPo = others.filter((s) => s.poNumber !== main.poNumber);
  if (offPo.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "Every style in a carton must be on the same PO",
    };
  }

  const byId = new Map(others.map((s) => [s.id, s]));
  const orderedOthers = otherIds.flatMap((id) => {
    const hit = byId.get(id);
    return hit ? [hit] : [];
  });

  const total =
    Number.isInteger(input.totalCartons) && (input.totalCartons as number) > 0
      ? (input.totalCartons as number)
      : 1;
  const baseKey = input.variantKey.split("#")[0];

  // Same in-flight guard as /carton-customize — a group render must not race the
  // runner or another customize on the main style.
  const inflight = await db.job.count({
    where: { styleId: main.id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return { ok: false, status: 409, error: "A job is already in flight for the main style" };
  }

  // RUNNING from the start so the background runner cannot claim it and render a
  // plain single-style output over the top.
  const job = await db.job.create({
    data: {
      styleId: main.id,
      prodSpecId: main.prodSpecId ?? null,
      triggerSource: "MANUAL_RERUN",
      status: "RUNNING",
      startedAt: new Date(),
      variantKeys: [baseKey],
    },
  });

  try {
    const result = await renderCartonCustomization(main.id, {
      variantKey: input.variantKey,
      total,
      siblingIds: orderedOthers.map((s) => s.id),
    });
    if (!result.ok) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "FAILED", error: result.error, finishedAt: new Date() },
      });
      return { ok: false, status: result.status, error: result.error };
    }

    const memberCount = orderedOthers.length + 1;
    // Style numbers come back from the render, resolved through the customer's
    // column mapping (`__name__` for Pre-Order, `manual.styleNumber` for
    // others). Deriving them from Style.rawData here would be wrong for any
    // customer that does not map the row name.
    const [mainNumber = "", ...otherNumbers] = result.styleNumbers;
    const fileName = cartonGroupFileName({
      poNumber: main.poNumber,
      mainStyleNumber: mainNumber,
      otherStyleNumbers: otherNumbers,
    });

    const group = await db.$transaction(async (tx) => {
      const asset = await tx.jobAsset.create({
        data: {
          jobId: job.id,
          docType: result.docType,
          variantKey: baseKey,
          displayName: `${result.layoutName} · ${memberCount} styles in one carton`,
          fileName,
          pdf: toBytes(result.pdf),
          placeholderCount: result.placeholderCount,
        },
      });
      const created = await tx.cartonGroup.create({
        data: {
          poNumber: main.poNumber as string,
          customerId: main.customerId,
          mainStyleId: main.id,
          variantKey: baseKey,
          totalCartons: total > 1 ? total : null,
          fileName,
          jobId: job.id,
          jobAssetId: asset.id,
          createdById: input.userId,
          styles: {
            create: [
              { styleId: main.id, slot: 1 },
              ...orderedOthers.map((s, i) => ({ styleId: s.id, slot: i + 2 })),
            ],
          },
        },
      });
      await tx.job.update({
        where: { id: job.id },
        data: { status: "AWAITING_REVIEW", finishedAt: new Date() },
      });
      await tx.style.update({ where: { id: main.id }, data: { status: "AWAITING_REVIEW" } });
      await tx.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message: `carton group created — ${memberCount} styles in one carton (${fileName})`,
        },
      });
      return created;
    });

    return { ok: true, groupId: group.id, jobId: job.id, fileName };
  } catch (e) {
    await db.job
      .update({
        where: { id: job.id },
        data: { status: "FAILED", error: (e as Error).message, finishedAt: new Date() },
      })
      .catch(() => {});
    throw e;
  }
}

export type RemoveGroupResult =
  | { ok: false; status: 400 | 404; error: string }
  | {
      ok: true;
      fileName: string;
      /** True when the PDF already reached the supplier's folder. */
      wasUploaded: boolean;
      folderUrl: string | null;
    };

// Ungroup is a SOFT delete.
//
// If the group's marking was already approved it was uploaded into the
// supplier's SharePoint folder, and we do not delete supplier files. Hard
// deleting the row would leave that file orphaned with nothing left in the app
// pointing at it — the supplier could go on printing a carton marking we no
// longer believe in. So the row survives, carrying the file name, and the board
// keeps showing "this file still needs deleting by hand".
//
// No email is ever sent to the supplier. The reviewer is told to delete the
// file themselves; that is the whole instruction.
export async function removeCartonGroup(input: {
  groupId: string;
  reason: string;
  userId: string;
}): Promise<RemoveGroupResult> {
  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, status: 400, error: "A reason is required to remove a carton group" };
  }

  const group = await db.cartonGroup.findUnique({
    where: { id: input.groupId },
    select: { id: true, fileName: true, jobId: true, jobAssetId: true, removedAt: true },
  });
  if (!group) return { ok: false, status: 404, error: "Carton group not found" };
  if (group.removedAt) {
    return { ok: false, status: 400, error: "This carton group was already removed" };
  }

  const asset = group.jobAssetId
    ? await db.jobAsset.findUnique({
        where: { id: group.jobAssetId },
        select: { spFileUrl: true, spUploadedAt: true },
      })
    : null;
  const wasUploaded = Boolean(asset?.spUploadedAt);

  const style = await db.cartonGroupStyle
    .findFirst({ where: { cartonGroupId: group.id, slot: 1 }, select: { styleId: true } })
    .then((row) =>
      row
        ? db.style.findUnique({
            where: { id: row.styleId },
            select: { styleFolderUrl: true, supplier: { select: { sharepointUrl: true } } },
          })
        : null,
    );

  await db.cartonGroup.update({
    where: { id: group.id },
    data: { removedAt: new Date(), removedById: input.userId, removedReason: reason },
  });

  if (group.jobId) {
    await db.log
      .create({
        data: {
          jobId: group.jobId,
          level: "INFO",
          message: wasUploaded
            ? `carton group removed — ${group.fileName} is still in the supplier folder and must be deleted by hand (${reason})`
            : `carton group removed before upload — nothing left the building (${reason})`,
        },
      })
      .catch(() => {});
  }

  return {
    ok: true,
    fileName: group.fileName,
    wasUploaded,
    folderUrl: style?.styleFolderUrl ?? style?.supplier?.sharepointUrl ?? null,
  };
}

// Buffer → plain Uint8Array for the Prisma Bytes column (mirrors the runner).
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}
