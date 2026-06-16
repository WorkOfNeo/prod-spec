// Standard care-label lines we ship — SEED DATA only.
//
// Care labels are DB-managed (src/lib/care-labels + the CareLabel table,
// edited at /settings/care-labels). This module is just the canonical shipped
// set used to seed one CareLabel ROW per standard clause.
//
// Per-language TEXT is NOT seeded here — every translation resolves through
// the Translation dictionary, whose ONLY source is the Monday translations
// board (board 9671510799, refreshed from /translations → "Sync from Monday").
// Add or change any wording there, then sync.

import { STANDARD_CARE_CLAUSES } from "./care-clauses";
import type { LaunderingAction } from "@/lib/care-labels/actions";

// The standard care-label lines we ship — one per clause, in print order.
// Seeded into the CareLabel table (idempotent by sourceText). Each carries its
// laundering `action` so prohibition symbols auto-remove it; the manual
// show/hide rules start empty and are configured per label in the admin UI.
export const STANDARD_CARE_LABELS: Array<{
  sourceText: string;
  sortOrder: number;
  action: LaunderingAction | null;
}> = STANDARD_CARE_CLAUSES.map((c, i) => ({
  sourceText: c.translations.en,
  sortOrder: i,
  action: c.action,
}));
