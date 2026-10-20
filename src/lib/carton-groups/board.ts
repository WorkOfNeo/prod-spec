import { db } from "@/lib/db";
import { CARTON_MARKING_DOC_TYPE } from "./doc-type";

// Data for the /carton-marking board: every carton marking we have generated,
// grouped by PO, newest delivery first.
//
// "Every" is deliberate — approved, pending and rejected all show. A carton
// marking that is stuck or wrong is precisely what a reviewer needs to find, and
// approved is merely the common case, not a filter on what exists.

// A board page is a review surface, not an archive: cap the window and tell the
// caller when it bit, rather than silently showing a subset.
export const BOARD_ASSET_CAP = 600;

export type BoardStyleRow = {
  styleId: string;
  styleName: string;
  styleNumber: string;
  colourName: string;
  cartonEan: string | null;
  jobAssetId: string;
  variantKey: string | null;
  fileName: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  placeholderCount: number;
  generatedAt: string;
  spFileUrl: string | null;
  spUploadedAt: string | null;
  folderUrl: string | null;
  /** Ids of the active groups this style is part of — the backtrack link. */
  groupIds: string[];
};

export type BoardGroupRow = {
  id: string;
  mainStyleId: string;
  fileName: string;
  totalCartons: number | null;
  createdAt: string;
  createdByName: string | null;
  members: Array<{ styleId: string; styleNumber: string; colourName: string; slot: number }>;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | null;
  spFileUrl: string | null;
  spUploadedAt: string | null;
  /** Populated only for removed groups — the file the reviewer must delete. */
  removedAt: string | null;
  removedByName: string | null;
  removedReason: string | null;
  removedFileWasUploaded: boolean;
};

export type BoardPo = {
  poNumber: string;
  customerName: string;
  supplierName: string | null;
  folderUrl: string | null;
  /** Newest SharePoint upload across everything in this PO; null if none. */
  lastUploadedAt: string | null;
  styles: BoardStyleRow[];
  groups: BoardGroupRow[];
  removedGroups: BoardGroupRow[];
};

export type BoardData = {
  pos: BoardPo[];
  truncated: boolean;
};

export async function loadCartonMarkingBoard(): Promise<BoardData> {
  // Newest asset per (style, output). Ordered newest-first so the first row we
  // see for a key IS the current one — same rule as getCurrentOutputsForStyle,
  // applied in bulk. `pdf` is deliberately never selected: these rows are whole
  // PDFs and a board would pull hundreds of megabytes.
  const assets = await db.jobAsset.findMany({
    where: { docType: CARTON_MARKING_DOC_TYPE, job: { style: { deletedAt: null } } },
    orderBy: { createdAt: "desc" },
    take: BOARD_ASSET_CAP,
    select: {
      id: true,
      variantKey: true,
      fileName: true,
      reviewStatus: true,
      placeholderCount: true,
      createdAt: true,
      spFileUrl: true,
      spUploadedAt: true,
      job: {
        select: {
          styleId: true,
          style: {
            select: {
              id: true,
              name: true,
              poNumber: true,
              cartonEan: true,
              rawData: true,
              styleFolderUrl: true,
              customer: { select: { name: true } },
              supplier: { select: { name: true, sharepointUrl: true } },
            },
          },
        },
      },
    },
  });

  const truncated = assets.length === BOARD_ASSET_CAP;

  const currentByKey = new Map<string, (typeof assets)[number]>();
  for (const a of assets) {
    const key = `${a.job.styleId}::${a.variantKey ?? ""}`;
    if (!currentByKey.has(key)) currentByKey.set(key, a);
  }
  const current = [...currentByKey.values()];

  const poNumbers = [
    ...new Set(current.map((a) => a.job.style.poNumber).filter((p): p is string => Boolean(p))),
  ];

  const groups = poNumbers.length
    ? await db.cartonGroup.findMany({
        where: { poNumber: { in: poNumbers } },
        orderBy: { createdAt: "desc" },
        include: { styles: { orderBy: { slot: "asc" } } },
      })
    : [];

  // Names of the people who created / removed groups, and the delivery state of
  // each group's asset. Two small lookups rather than N per group.
  const userIds = [
    ...new Set(
      groups.flatMap((g) => [g.createdById, g.removedById]).filter((u): u is string => Boolean(u)),
    ),
  ];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const groupAssetIds = groups
    .map((g) => g.jobAssetId)
    .filter((id): id is string => Boolean(id));
  const groupAssets = groupAssetIds.length
    ? await db.jobAsset.findMany({
        where: { id: { in: groupAssetIds } },
        select: { id: true, reviewStatus: true, spFileUrl: true, spUploadedAt: true },
      })
    : [];
  const groupAsset = new Map(groupAssets.map((a) => [a.id, a]));

  // Style display fields for group members that may not have a carton asset of
  // their own (so they never appeared in the asset query).
  const memberIds = [...new Set(groups.flatMap((g) => g.styles.map((s) => s.styleId)))];
  const memberStyles = memberIds.length
    ? await db.style.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, name: true, rawData: true },
      })
    : [];
  const memberById = new Map(memberStyles.map((s) => [s.id, s]));

  const activeGroupIdsByStyle = new Map<string, string[]>();
  for (const g of groups) {
    if (g.removedAt) continue;
    for (const s of g.styles) {
      const list = activeGroupIdsByStyle.get(s.styleId) ?? [];
      list.push(g.id);
      activeGroupIdsByStyle.set(s.styleId, list);
    }
  }

  const toGroupRow = (g: (typeof groups)[number]): BoardGroupRow => {
    const asset = g.jobAssetId ? groupAsset.get(g.jobAssetId) : undefined;
    return {
      id: g.id,
      mainStyleId: g.mainStyleId,
      fileName: g.fileName,
      totalCartons: g.totalCartons,
      createdAt: g.createdAt.toISOString(),
      createdByName: g.createdById ? (userName.get(g.createdById) ?? null) : null,
      members: g.styles.map((s) => {
        const st = memberById.get(s.styleId);
        return {
          styleId: s.styleId,
          styleNumber: styleNumberFrom(st?.name ?? null, st?.rawData),
          colourName: colourFrom(st?.rawData),
          slot: s.slot,
        };
      }),
      reviewStatus: asset?.reviewStatus ?? null,
      spFileUrl: asset?.spFileUrl ?? null,
      spUploadedAt: asset?.spUploadedAt?.toISOString() ?? null,
      removedAt: g.removedAt?.toISOString() ?? null,
      removedByName: g.removedById ? (userName.get(g.removedById) ?? null) : null,
      removedReason: g.removedReason,
      removedFileWasUploaded: Boolean(asset?.spUploadedAt),
    };
  };

  const byPo = new Map<string, BoardPo>();
  for (const a of current) {
    const style = a.job.style;
    const po = style.poNumber ?? "(no PO)";
    let entry = byPo.get(po);
    if (!entry) {
      entry = {
        poNumber: po,
        customerName: style.customer.name,
        supplierName: style.supplier?.name ?? null,
        folderUrl: style.styleFolderUrl ?? style.supplier?.sharepointUrl ?? null,
        lastUploadedAt: null,
        styles: [],
        groups: [],
        removedGroups: [],
      };
      byPo.set(po, entry);
    }
    entry.styles.push({
      styleId: style.id,
      styleName: style.name,
      styleNumber: styleNumberFrom(style.name, style.rawData),
      colourName: colourFrom(style.rawData),
      cartonEan: style.cartonEan,
      jobAssetId: a.id,
      variantKey: a.variantKey,
      fileName: a.fileName,
      reviewStatus: a.reviewStatus,
      placeholderCount: a.placeholderCount,
      generatedAt: a.createdAt.toISOString(),
      spFileUrl: a.spFileUrl,
      spUploadedAt: a.spUploadedAt?.toISOString() ?? null,
      folderUrl: style.styleFolderUrl ?? style.supplier?.sharepointUrl ?? null,
      groupIds: activeGroupIdsByStyle.get(style.id) ?? [],
    });
  }

  for (const g of groups) {
    const entry = byPo.get(g.poNumber);
    if (!entry) continue;
    const row = toGroupRow(g);
    if (g.removedAt) entry.removedGroups.push(row);
    else entry.groups.push(row);
  }

  for (const entry of byPo.values()) {
    const stamps = [
      ...entry.styles.map((s) => s.spUploadedAt),
      ...entry.groups.map((g) => g.spUploadedAt),
    ].filter((d): d is string => Boolean(d));
    entry.lastUploadedAt = stamps.length ? stamps.sort().at(-1)! : null;
  }

  // Newest delivered PO first. POs with nothing uploaded yet sort last but stay
  // visible — "not delivered" is a state a reviewer needs to see, not hide.
  const pos = [...byPo.values()].sort((a, b) => {
    if (a.lastUploadedAt && b.lastUploadedAt) {
      return b.lastUploadedAt.localeCompare(a.lastUploadedAt);
    }
    if (a.lastUploadedAt) return -1;
    if (b.lastUploadedAt) return 1;
    return b.poNumber.localeCompare(a.poNumber);
  });

  return { pos, truncated };
}

// Style number = the Monday row name's leading token for Pre-Order boards; the
// full name is the fallback. Display only — anything that NAMES A FILE must use
// the render's mapped styleNumbers instead (see carton-render).
function styleNumberFrom(name: string | null, rawData: unknown): string {
  const fromRaw =
    rawData && typeof rawData === "object" && "name" in rawData
      ? (rawData as { name?: unknown }).name
      : null;
  const source = typeof fromRaw === "string" && fromRaw.trim() ? fromRaw : (name ?? "");
  return source.trim().split(/\s+/)[0] ?? "";
}

// The Colour code ("🎨 Color Code" dropdown, e.g. "*A"/"*B") off the raw Monday
// snapshot — mapped column then manual fallback, matching readColourCode on
// /po-eans. Two colourways of one style share a style NUMBER and differ only by
// this code, so without it a carton group's member list is ambiguous.
function colourFrom(rawData: unknown): string {
  const cols = (
    rawData as {
      column_values?: Array<{ id?: string; text?: string | null; display_value?: string | null }>;
    }
  )?.column_values;
  if (!Array.isArray(cols)) return "";
  for (const id of ["dropdown__1", "manual.colourCode"]) {
    const c = cols.find((x) => x.id === id);
    const v = (c?.text ?? "").trim() || (c?.display_value ?? "").trim();
    if (v) return v;
  }
  return "";
}
