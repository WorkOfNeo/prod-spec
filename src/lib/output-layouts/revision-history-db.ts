import { db } from "@/lib/db";
import { orEmpty } from "@/lib/change-requests/db-safe";
import { listRevisions, openDraftFor } from "./revisions";
import {
  revisionUserIds,
  toOpenDraftView,
  toRevisionViews,
  type LayoutHistoryData,
} from "./revision-history";

// Loads the Output Builder History panel's data for one layout: every
// revision (newest first, authors resolved to emails) and the open draft the
// editor warns about, with the change request it belongs to. SERVER-ONLY.
//
// Degrades like every change-request reader: before the migration is deployed
// the revision readers return empty, and the request lookup reads a missing
// table as "no request" — the builder page stays up either way.
export async function loadLayoutHistory(layoutId: string): Promise<LayoutHistoryData> {
  const [rows, draft] = await Promise.all([listRevisions(layoutId), openDraftFor(layoutId)]);

  const userIds = revisionUserIds(rows);
  const [users, output] = await Promise.all([
    userIds.length > 0
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : Promise.resolve([]),
    draft?.changeRequestOutputId
      ? orEmpty(
          db.changeRequestOutput.findUnique({
            where: { id: draft.changeRequestOutputId },
            select: { requestId: true },
          }),
          null,
        )
      : Promise.resolve(null),
  ]);

  return {
    revisions: toRevisionViews(rows, new Map(users.map((u) => [u.id, u.email]))),
    openDraft: draft ? toOpenDraftView(draft, output?.requestId ?? null) : null,
  };
}
