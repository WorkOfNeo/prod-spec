import { db } from "@/lib/db";

// Open rejection-log threads per style, for the review lists: "with the admin"
// (OPEN / IN_PROGRESS — waiting for a fix) and "to look at again" (FIXED —
// the admin says it's done, the reviewer hasn't approved it yet).

export type StyleCommentCounts = Record<string, { open: number; fixed: number }>;

export async function loadStyleCommentCounts(styleIds: string[]): Promise<StyleCommentCounts> {
  if (styleIds.length === 0) return {};
  const rows = await db.rejectionTicket.groupBy({
    by: ["styleId", "status"],
    where: { styleId: { in: styleIds }, status: { in: ["OPEN", "IN_PROGRESS", "FIXED"] } },
    _count: { _all: true },
  });
  const out: StyleCommentCounts = {};
  for (const r of rows) {
    const c = (out[r.styleId] ??= { open: 0, fixed: 0 });
    if (r.status === "FIXED") c.fixed += r._count._all;
    else c.open += r._count._all;
  }
  return out;
}
