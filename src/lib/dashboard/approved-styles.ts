import { db } from "@/lib/db";

// The /reviews "Approved" tab — the done pile, for the sense of progress the
// live tabs can't give (styles vanish from the board the moment they're
// fully approved). Recent-first, capped for display; the badge carries the
// true total. Each row also says how far DELIVERY got (the supplier-send
// queue state), so "approved" visibly becomes "in the supplier's folder" and
// finally "sent" without leaving the board.

export type ApprovedStyleRow = {
  styleId: string;
  name: string;
  poNumber: string | null;
  customer: string;
  businessArea: string | null;
  approvedAt: Date;
  // Delivery rollup from the style's supplier-send queue rows:
  //   sent      — every captured output went out in a digest
  //   uploaded  — files in the supplier folder, digest pending
  //   queued    — captured, upload pending (or sending switched off)
  //   none      — nothing captured (e.g. skip-delivery customer)
  delivery: "sent" | "uploaded" | "queued" | "none";
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
      },
    }),
  ]);

  const queueRows = rows.length
    ? await db.supplierSendQueueItem.findMany({
        where: { styleId: { in: rows.map((r) => r.id) } },
        select: { styleId: true, sentAt: true, sharePointStatus: true },
      })
    : [];
  const byStyle = new Map<string, { total: number; sent: number; uploaded: number }>();
  for (const q of queueRows) {
    const s = byStyle.get(q.styleId) ?? { total: 0, sent: 0, uploaded: 0 };
    s.total += 1;
    if (q.sentAt != null) s.sent += 1;
    else if (q.sharePointStatus === "UPLOADED") s.uploaded += 1;
    byStyle.set(q.styleId, s);
  }
  const deliveryOf = (styleId: string): ApprovedStyleRow["delivery"] => {
    const s = byStyle.get(styleId);
    if (!s || s.total === 0) return "none";
    if (s.sent === s.total) return "sent";
    if (s.sent + s.uploaded === s.total) return "uploaded";
    return "queued";
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
    })),
  };
}
