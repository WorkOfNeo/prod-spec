// Pure care-label visibility logic — NO database imports, so it can be
// shared by the renderer (server) and the admin preview (client) without
// dragging Prisma into the client bundle. The renderer and the live
// preview must agree exactly; keeping the rule in one place guarantees it.

import type { LaunderingAction } from "./actions";

export type CareLabel = {
  id: string;
  sourceText: string;
  sortOrder: number;
  // The laundering action this line's text is about. A present restrictive
  // symbol of the same action removes the line (the primary rule). null ⇒
  // never auto-suppressed.
  action: LaunderingAction | null;
  // Wash-care symbol CODES this line's visibility additionally depends on
  // (manual override on top of the action rule).
  showIfSymbols: string[];
  hideIfSymbols: string[];
  active: boolean;
};

// A wash-care symbol present on a style, with the bits visibility needs: its
// code (for manual show/hide matching) and its action + prohibition flag (for
// the action rule). The renderer builds these from the symbol catalogue; the
// admin preview builds them from the picked symbols.
export type PresentSymbol = {
  code: string;
  action: LaunderingAction | null;
  restrictive: boolean;
};

// Coerce a JSON column / unknown input into a clean string[] (drop
// non-strings / blanks, de-dupe). Symbol codes are matched verbatim
// against Style.washSymbols.
export function toSymbolCodeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const code = v.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// Whether a care label prints, given the wash-care symbols present on a style.
// Derived from explainCareLabelVisibility so the boolean and the explanation
// can never drift. Rules (in precedence order):
//   • action-prohibited → hidden. A present restrictive symbol ("Do not iron")
//     of the same action removes the line. This is authoritative — "prohibition
//     symbols always override extra care instructions".
//   • hideIfSymbols match → hidden (manual override).
//   • showIfSymbols set   → shown only if at least one is present.
//   • none of the above   → always shown.
export function isCareLabelVisible(
  label: Pick<CareLabel, "action" | "showIfSymbols" | "hideIfSymbols">,
  present: PresentSymbol[],
): boolean {
  return explainCareLabelVisibility(label, present).visible;
}

// Explain a label's visibility for a given symbol set — used by the renderer
// (.visible) and by the admin preview to show *why* a line is shown or hidden.
export function explainCareLabelVisibility(
  label: Pick<CareLabel, "action" | "showIfSymbols" | "hideIfSymbols">,
  present: PresentSymbol[],
): {
  visible: boolean;
  reason: "always" | "action-prohibited" | "hidden-by" | "show-gate-met" | "show-gate-unmet";
  // For action-prohibited / hidden-by / show-gate-met: the symbol codes that
  // drove the decision. Empty otherwise.
  matchedCodes: string[];
} {
  // 1. Action prohibition wins over everything.
  if (label.action) {
    const blockers = present.filter((s) => s.restrictive && s.action === label.action);
    if (blockers.length > 0) {
      return { visible: false, reason: "action-prohibited", matchedCodes: blockers.map((s) => s.code) };
    }
  }

  const codes = new Set(present.map((s) => s.code));

  // 2. Manual hide-if override.
  const hitHide = label.hideIfSymbols.filter((code) => codes.has(code));
  if (hitHide.length > 0) {
    return { visible: false, reason: "hidden-by", matchedCodes: hitHide };
  }

  // 3. Manual show-if gate.
  if (label.showIfSymbols.length > 0) {
    const hitShow = label.showIfSymbols.filter((code) => codes.has(code));
    return hitShow.length > 0
      ? { visible: true, reason: "show-gate-met", matchedCodes: hitShow }
      : { visible: false, reason: "show-gate-unmet", matchedCodes: [] };
  }

  return { visible: true, reason: "always", matchedCodes: [] };
}
