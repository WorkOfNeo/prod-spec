import { db } from "@/lib/db";

// The /reviews "Approved" tab — the done pile, for the sense of progress the
// live tabs can't give (styles vanish from the board the moment they're
// fully approved). Recent-first, capped for display; the badge carries the
// true total. Each row says how far DELIVERY got — but success is simply "in
// the supplier's folder": the nightly digest "sent" step isn't surfaced
// (an already-sent row is already uploaded, and files-in-the-folder is the
// outcome operators care about).

export type ApprovedStyleRow = {
  styleId: string;
  name: string;
  poNumber: string | null;
  customer: string;
  businessArea: string | null;
  approvedAt: Date;
  // Delivery rollup from the style's supplier-send queue rows:
  //   uploaded  — every captured output is in the supplier folder (→ green + link)
  //   queued    — captured, upload still pending (or sending switched off)
  //   none      — nothing captured (e.g. skip-delivery customer)
  delivery: "uploaded" | "queued" | "none";
  // The supplier's "APPROVED LAYOUTS" folder — the chip links here when uploaded.
  folderUrl: string | null;
};

const DISPLAY_CAP = 100;

export async function getApprovedStyles(): Promise<{ total: number; styles: ApprovedStyleRow[] }> {
  const [total, rows] = await Promise.all([
    db.style.count({ where: { status: "APPROVED" } }),
    db.style.findMany({
      where: { status: "APPROVED" },
      orderBy: { updatedAt: "desc" },
      take: DISPLAY_CAP,
      select: {
        id: true,
        name: true,
        poNumber: true,
        updatedAt: true,
        businessArea: true,
        businessAreaRef: { select: { name: true } },
        customer: { select: { name: true } },
        // Fallback folder link when a queue row hasn't captured one (older push).
        supplierFolderUrl: true,
      },
    }),
  ]);

  const queueRows = rows.length
    ? await db.supplierSendQueueItem.findMany({
        where: { styleId: { in: rows.map((r) => r.id) } },
        select: { styleId: true, sentAt: true, sharePointStatus: true, sharePointFolderUrl: true },
      })
    : [];
  // A row counts as "in the folder" once it's UPLOADED — OR already sent (a sent
  // row was uploaded first; sentAt just means the digest went out).
  const byStyle = new Map<string, { total: number; inFolder: number; folderUrl: string | null }>();
  for (const q of queueRows) {
    const s = byStyle.get(q.styleId) ?? { total: 0, inFolder: 0, folderUrl: null };
    s.total += 1;
    if (q.sentAt != null || q.sharePointStatus === "UPLOADED") {
      s.inFolder += 1;
      if (!s.folderUrl && q.sharePointFolderUrl) s.folderUrl = q.sharePointFolderUrl;
    }
    byStyle.set(q.styleId, s);
  }
  const deliveryOf = (styleId: string): ApprovedStyleRow["delivery"] => {
    const s = byStyle.get(styleId);
    if (!s || s.total === 0) return "none";
    return s.inFolder === s.total ? "uploaded" : "queued";
  };

  // Live DB has BusinessArea rows literally named "–" — blank those for display.
  const ba = (refName: string | null | undefined, freeText: string | null): string | null => {
    const t = (refName?.trim() || freeText?.trim()) ?? "";
    return t === "" || t === "–" || t === "-" ? null : t;
  };

  return {
    total,
    styles: rows.map((r) => ({
      styleId: r.id,
      name: r.name,
      poNumber: r.poNumber,
      customer: r.customer.name,
      businessArea: ba(r.businessAreaRef?.name, r.businessArea),
      approvedAt: r.updatedAt,
      delivery: deliveryOf(r.id),
      folderUrl: byStyle.get(r.id)?.folderUrl ?? r.supplierFolderUrl ?? null,
    })),
  };
}
