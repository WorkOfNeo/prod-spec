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
// Active = carries a PO number AND not archived / not deleted (soft Monday
// lifecycle) AND not in a hidden Monday group ("Templates" / "Done", see
// HIDDEN_STYLE_GROUP_TERMS) — EXCEPT Done-group styles whose PO number parses
// above the operator cutoff (the backfilled-orders review window). That
// exception can't be a static where-clause: it needs a pre-scan + numeric PO
// parse, so this is an async builder. Callers that already hold the cutoff /
// id set (the /styles page does) pass them in to avoid re-querying.

// A style's PO number is the Monday Pre-Order board's "Navision Task" column,
// synced into Style.poNumber (MONDAY_PRE_ORDER_COL_PO_NUMBER in
// src/lib/monday/boards.ts). Nothing can be generated without a PO, so the
// flow *starts* there: until the buyer fills that cell the row is a
// placeholder, not work — it syncs, but it doesn't list. Trim-aware, because
// a whitespace-only cell is every bit as unset as an empty one.
export function hasPoNumber(poNumber: string | null | undefined): boolean {
  return Boolean(poNumber && poNumber.trim());
}

// The SQL half of hasPoNumber. Postgres can't run the trim-aware predicate as
// a plain filter, so the where-clause covers the two shapes the Monday sync
// actually writes — NULL (column absent from the item) and "" (cell cleared).
// The rare whitespace-only cell slips through here and is caught by
// hasPoNumber on the surfaces that render rows.
const HAS_PO_NUMBER_WHERE = {
  poNumber: { not: null, notIn: [""] },
} satisfies Prisma.StyleWhereInput;

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
  // Opt OUT of the PO-number gate and return the PO-less styles too. Exactly
  // one caller wants this: the /styles list, which loads the superset so the
  // gated rows stay *reachable* — they're soft-hidden in the browser and
  // revealed by flipping the "PO" attribute chip to "No PO". Hidden must not
  // mean undebuggable. Every other caller (/combos, /admin config gaps, the
  // Needs-input dashboard) takes the default and gets the gate.
  includeMissingPo?: boolean;
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
    // The PO-number gate, AND-ed ABOVE the OR so it also holds for the two
    // re-admissions below. Neither loses a row to it: a Done-cutoff style is
    // selected by parsing its PO, and a pulled-for-test style is looked up BY
    // PO — both carry one by construction.
    ...(opts?.includeMissingPo ? {} : HAS_PO_NUMBER_WHERE),
    OR: [
      {
        NOT: HIDDEN_STYLE_GROUP_TERMS.map((term) => ({
          groupTitle: { contains: term, mode: "insensitive" as const },
        })),
      },
      ...(doneCutoffIds.size > 0 ? [{ id: { in: [...doneCutoffIds] } }] : []),
      // Manually pulled-in styles (Settings ▸ Pull style by PO) are surfaced
      // regardless of their Monday group — that's the whole point of pulling a
      // historical (typically Done-group) PO in to test its output layouts.
      { pulledForTestAt: { not: null } },
    ],
  };
}
