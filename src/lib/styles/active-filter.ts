import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { HIDDEN_STYLE_GROUP_TERMS } from "@/lib/import/heuristics";
import { getDoneGroupPoCutoff } from "@/lib/settings/app-settings";
import { parsePoNumberValue } from "@/lib/po/po-number";

// The EXACT predicate the /styles list uses to decide which styles are
// "active" / in the list — factored out so other surfaces (the Customer ×
// Business-Area combo registry at /combos, future reports) share one
// definition and can never drift from what the operator sees on /styles.
//
// Active = not archived / not deleted (soft Monday lifecycle) AND not in a
// hidden Monday group ("Templates" / "Done", see HIDDEN_STYLE_GROUP_TERMS) —
// EXCEPT Done-group styles whose PO number parses above the operator cutoff
// (the backfilled-orders review window). That exception can't be a static
// where-clause: it needs a pre-scan + numeric PO parse, so this is an async
// builder. Callers that already hold the cutoff / id set (the /styles page
// does) pass them in to avoid re-querying.

// Pre-scan the Done group for styles whose PO parses above `doneCutoff` —
// these are re-admitted into the active set. Empty when no cutoff is set.
export async function resolveDoneCutoffIds(doneCutoff: number | null): Promise<Set<string>> {
  const ids = new Set<string>();
  if (doneCutoff === null) return ids;
  const candidates = await db.style.findMany({
    where: {
      archivedAt: null,
      deletedAt: null,
      groupTitle: { contains: "done", mode: "insensitive" },
      poNumber: { not: null },
    },
    select: { id: true, poNumber: true },
  });
  for (const c of candidates) {
    if ((parsePoNumberValue(c.poNumber) ?? -1) > doneCutoff) ids.add(c.id);
  }
  return ids;
}

export async function activeStylesWhere(opts?: {
  doneCutoff?: number | null;
  doneCutoffIds?: Set<string>;
}): Promise<Prisma.StyleWhereInput> {
  // Use a caller-supplied id set verbatim; otherwise resolve from the
  // caller's cutoff, falling back to the stored AppSetting.
  const doneCutoffIds =
    opts?.doneCutoffIds ??
    (await resolveDoneCutoffIds(opts?.doneCutoff ?? (await getDoneGroupPoCutoff())));

  return {
    // Archived / deleted Monday items are retained for the audit log but
    // never count as active (soft lifecycle stamped by the webhook).
    archivedAt: null,
    deletedAt: null,
    OR: [
      {
        NOT: HIDDEN_STYLE_GROUP_TERMS.map((term) => ({
          groupTitle: { contains: term, mode: "insensitive" as const },
        })),
      },
      ...(doneCutoffIds.size > 0 ? [{ id: { in: [...doneCutoffIds] } }] : []),
    ],
  };
}
