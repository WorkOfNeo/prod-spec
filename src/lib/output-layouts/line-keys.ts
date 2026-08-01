// =====================================================
// Line addressing for reviewer line overrides — CLIENT-SAFE (like schema.ts /
// calc.ts / carton-qty.ts), no server deps. The renderer, the review UI and the
// DB layer all build keys through here so they can never disagree.
//
// Storage and semantics live in @/lib/outputs/output-line-values (which
// re-exports these, so server callers need one import).
// =====================================================

// LayoutBlockSchema caps an authored line at 500 chars; an override IS a line,
// so it obeys the same ceiling.
export const MAX_LINE_LENGTH = 500;

// Address one line inside a layout definition.
//
// Both ids are stable: LayoutPage.id is required by LayoutPageSchema, and
// parseLayoutDef injects a deterministic LayoutBlock.id into every block that
// lacks one (verified across all 121 live layouts — zero blocks without an id
// after parsing). The line INDEX is positional, which is the one soft spot:
// inserting a line above an overridden one in Output Builder shifts the
// address. Accepted by design — the review lifecycle is edit → re-render →
// approve, and an approved output is never regenerated, so a later layout edit
// cannot disturb a document that already shipped.
export function lineOverrideKey(pageId: string, blockId: string, lineIndex: number): string {
  return `${pageId}|${blockId}|${lineIndex}`;
}

// Shape check for a key coming off the wire. Ids are schema-bounded (page ≤40,
// block ≤60 chars) and the index is a small integer; anything else is a
// mis-wired client, not a line we know about.
export function isLineKey(key: string): boolean {
  const parts = key.split("|");
  if (parts.length !== 3) return false;
  const [pageId, blockId, idx] = parts;
  if (!pageId || pageId.length > 40) return false;
  if (!blockId || blockId.length > 60) return false;
  return /^\d{1,3}$/.test(idx);
}
