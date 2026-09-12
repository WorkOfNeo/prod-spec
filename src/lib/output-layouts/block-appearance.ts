// =====================================================
// Block APPEARANCE — the formatting half of a LayoutBlock.
//
// A block carries three separable things:
//
//   • placement — `rect` / `anchor` / `cols`   (unique per block)
//   • content   — `lines`                      (unique per block)
//   • appearance — everything else the Block panel edits
//
// Only the third repeats. Measured across the 160 live layouts (1,419
// blocks), blocks on the same page already agree on their page's dominant
// value: fitWidth 100%, border on/off 96%, lineHeight 89%, bold 88%,
// align/valign ~78%, fontPt 61%. Meanwhile a freshly drawn block was born
// at a hardcoded 9 pt, which is the dominant size on only 54 of 204 pages
// — so the author retyped it on most blocks of most layouts.
//
// This module is the single definition of "which fields are appearance",
// plus the three operations the builder needs over it: read it off a block,
// stamp it onto a block, and reset it. Kept out of layout-editor.tsx so it
// is unit-testable, and kept free of React/server imports so any surface
// can use it.
// =====================================================
import type { LayoutBlock, LayoutRect } from "./schema";

// Every field that counts as appearance. Adding a formatting field to
// LayoutBlockSchema means adding it here too, or it silently stops being
// inherited/copied — the type below is what makes that visible: it is
// derived from LayoutBlock, so a renamed field breaks the build.
export const BLOCK_APPEARANCE_KEYS = [
  "align",
  "valign",
  "fontPt",
  "bold",
  "lineHeight",
  "fitWidth",
  "fitHeight",
  "border",
  "invert",
  "invertBg",
  "invertText",
] as const;

export type BlockAppearanceKey = (typeof BLOCK_APPEARANCE_KEYS)[number];
export type BlockAppearance = Pick<LayoutBlock, BlockAppearanceKey>;

// What a block looks like with nothing set — the values addRectBlock used to
// hardcode. Now the reset target ("Plain") as well as the last-resort seed
// for the first block on an empty layout, so the two can never drift.
export const PLAIN_APPEARANCE: BlockAppearance = {
  align: "left",
  valign: "top",
  fontPt: 9,
  bold: false,
  lineHeight: 1.4,
  fitWidth: false,
  fitHeight: false,
  invert: false,
};

// Deep-copy a border so a pasted appearance can never ALIAS its source —
// `border.pad` is a nested object, and sharing it would make editing one
// block's padding silently move every block that inherited from it.
function cloneBorder(border: LayoutBlock["border"]): LayoutBlock["border"] {
  if (!border) return undefined;
  return {
    ...border,
    ...(border.pad ? { pad: { ...border.pad } } : {}),
  };
}

// Read the appearance off a block. Absent optional fields stay absent, so
// "no border" round-trips as no border rather than as an empty object.
export function pickAppearance(block: Partial<LayoutBlock>): BlockAppearance {
  const out: Record<string, unknown> = {};
  for (const k of BLOCK_APPEARANCE_KEYS) {
    const v = block[k];
    if (v === undefined) continue;
    out[k] = k === "border" ? cloneBorder(v as LayoutBlock["border"]) : v;
  }
  return out as BlockAppearance;
}

// The patch that makes a block look exactly like `appearance` — including
// UNSETTING what the source doesn't have. Stamping a plain appearance onto
// a bordered block must remove the border, otherwise "make this look like
// that" quietly leaves the target half-styled. Undefined is the right
// eraser here: LayoutBlockSchema marks these fields `.optional()`, and
// JSON.stringify drops undefined keys on save.
export function appearancePatch(appearance: BlockAppearance): Partial<LayoutBlock> {
  const patch: Record<string, unknown> = {};
  for (const k of BLOCK_APPEARANCE_KEYS) {
    const v = appearance[k];
    patch[k] = k === "border" ? cloneBorder(v as LayoutBlock["border"]) : v;
  }
  return patch as Partial<LayoutBlock>;
}

// Stamp an appearance onto a block, leaving placement and content alone.
export function applyAppearance(block: LayoutBlock, appearance: BlockAppearance): LayoutBlock {
  return { ...block, ...appearancePatch(appearance) };
}

// Where a duplicate of `rect` goes: directly BELOW the original when the
// grid has room for it, else directly to its right, else exactly on top of
// it (the author then drags it — better than refusing to duplicate, and the
// new block is selected so it is obvious which one moves).
export function duplicateRect(
  rect: LayoutRect,
  grid: { cols: number; rows: number },
): LayoutRect {
  const below = rect.row + rect.rowSpan;
  if (below + rect.rowSpan <= grid.rows) return { ...rect, row: below };
  const right = rect.col + rect.colSpan;
  if (right + rect.colSpan <= grid.cols) return { ...rect, col: right };
  return { ...rect };
}
