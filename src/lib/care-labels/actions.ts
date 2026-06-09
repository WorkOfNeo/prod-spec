// Canonical laundering actions — the closed GINETEX set the colleague's spec
// names (Washing, Bleaching, Tumble drying, Ironing, Dry cleaning). Mirrors
// the Prisma `LaunderingAction` enum (prisma/schema.prisma) value-for-value,
// but kept DB-free so the renderer, the live admin preview, and client
// components can import it without dragging generated Prisma types into the
// bundle.
//
// A wash-care symbol concerns one action; a care-instruction line is about one
// action. A *restrictive* symbol (a "Do not …" prohibition) removes every care
// line sharing its action. See ./visibility.

export const LAUNDERING_ACTIONS = [
  "WASHING",
  "BLEACHING",
  "TUMBLE_DRYING",
  "IRONING",
  "DRY_CLEANING",
] as const;

export type LaunderingAction = (typeof LAUNDERING_ACTIONS)[number];

// Human-readable labels for admin selects + badges.
export const LAUNDERING_ACTION_LABELS: Record<LaunderingAction, string> = {
  WASHING: "Washing",
  BLEACHING: "Bleaching",
  TUMBLE_DRYING: "Tumble drying",
  IRONING: "Ironing",
  DRY_CLEANING: "Dry cleaning",
};

// Narrow arbitrary input (a JSON/enum column value, a request body field) to a
// valid action or null. Empty string / unknown / non-string ⇒ null.
export function toLaunderingAction(value: unknown): LaunderingAction | null {
  return typeof value === "string" &&
    (LAUNDERING_ACTIONS as readonly string[]).includes(value)
    ? (value as LaunderingAction)
    : null;
}
