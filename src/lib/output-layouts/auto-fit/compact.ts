// Compaction — the "move blocks" half of the auto-fit solver. Pure.
//
// Inside one section (a run of rows clear of seams and the fold), every block
// is shrunk to the height it really needs, the blocks above the target slide
// up and the blocks below slide down — order and columns kept, a fixed gap
// between neighbours — and the target is stretched over whatever that freed.

import { pageGrid, type LayoutPage, type LayoutRect } from "../schema";
import { rowHeightMm, type RowSpan } from "./geometry";

export type CompactOptions = {
  // Vertical gap kept between stacked blocks that share columns.
  gapMm?: number;
  // Blocks that print only on SOME styles ({{cert:*}}, {{if}}): they keep at
  // least their authored height, because the sample styles may all happen to
  // leave them empty.
  conditional?: ReadonlySet<number>;
  // Put the target below every block in the section instead of where it sits
  // today — used when the target moves to the other side of the fold.
  insertAtBottom?: boolean;
};

export type CompactResult = {
  page: LayoutPage;
  moved: number;
  resized: number;
  targetHeightMm: number;
  // Indices of the blocks this pass placed (the ones a verify pass must check).
  affected: Set<number>;
};

const overlapCols = (a: LayoutRect, b: LayoutRect) => a.col < b.col + b.colSpan && b.col < a.col + a.colSpan;

// `needsMm[i]` is block i's worst-case printed height over the sample styles.
// Returns null when the blocks alone already fill the section.
export function compactAround(
  page: LayoutPage,
  target: number,
  section: RowSpan,
  needsMm: readonly number[],
  opts: CompactOptions = {},
): CompactResult | null {
  const rowMm = rowHeightMm(page);
  const gap = Math.max(1, Math.round((opts.gapMm ?? 1) / rowMm));
  const conditional = opts.conditional ?? new Set<number>();
  let [s0, s1] = section;
  const d = structuredClone(page);
  const tRect = d.blocks[target]?.rect;
  if (!tRect) return null;
  const others = d.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b, i }) => i !== target && b.rect && b.lines.some((l) => l.trim()));
  // A block straddling a section edge (printed across the fold, say) is fixed:
  // shrink the working section so nothing lands on it.
  for (const { b } of others) {
    const top = b.rect!.row;
    const bot = b.rect!.row + b.rect!.rowSpan - 1;
    if (bot < s0 || top > s1) continue;
    if (top < s0) s0 = Math.max(s0, bot + 1);
    if (bot > s1) s1 = Math.min(s1, top - 1);
  }
  const inSec = others.filter(({ b }) => b.rect!.row >= s0 && b.rect!.row + b.rect!.rowSpan - 1 <= s1);
  const span = (i: number) => {
    const n = Math.ceil(((needsMm[i] ?? 0) + 0.2) / rowMm);
    return conditional.has(i) ? Math.max(d.blocks[i].rect!.rowSpan, n) : Math.max(1, n);
  };
  const split = opts.insertAtBottom ? s1 + 1 : tRect.row;
  const above = inSec.filter(({ b }) => b.rect!.row < split).sort((a, z) => a.b.rect!.row - z.b.rect!.row);
  const below = inSec
    .filter(({ b }) => b.rect!.row >= split)
    .sort((a, z) => z.b.rect!.row + z.b.rect!.rowSpan - (a.b.rect!.row + a.b.rect!.rowSpan));

  let moved = 0;
  let resized = 0;
  const place = (b: (typeof inSec)[number]["b"], row: number, rowSpan: number) => {
    if (rowSpan !== b.rect!.rowSpan) resized++;
    if (row !== b.rect!.row) moved++;
    b.rect = { ...b.rect!, row, rowSpan };
    return b.rect;
  };
  const placedAbove: LayoutRect[] = [];
  for (const { b, i } of above) {
    let top = s0;
    for (const q of placedAbove) if (overlapCols(q, b.rect!)) top = Math.max(top, q.row + q.rowSpan + gap);
    placedAbove.push(place(b, top, span(i)));
  }
  const placedBelow: LayoutRect[] = [];
  for (const { b, i } of below) {
    let bottom = s1;
    for (const q of placedBelow) if (overlapCols(q, b.rect!)) bottom = Math.min(bottom, q.row - gap);
    const rows = span(i);
    placedBelow.push(place(b, bottom - rows + 1, rows));
  }
  const placed = [...placedAbove, ...placedBelow];
  if (placed.some((q) => q.row < s0 || q.row + q.rowSpan - 1 > s1)) return null;

  // The target takes the full width between the two stacks; if a block that
  // shares only some columns sits in that gap, it keeps its own columns.
  const { cols } = pageGrid(d);
  const full: LayoutRect = { col: 0, row: 0, colSpan: cols, rowSpan: 1 };
  let top = s0;
  let bottom = s1;
  for (const q of placedAbove) if (overlapCols(q, full)) top = Math.max(top, q.row + q.rowSpan + gap);
  for (const q of placedBelow) if (overlapCols(q, full)) bottom = Math.min(bottom, q.row - gap);
  if (bottom < top) return null;
  const wide: LayoutRect = { col: 0, row: top, colSpan: cols, rowSpan: bottom - top + 1 };
  const clash = placed.some((q) => overlapCols(q, wide) && q.row <= bottom && q.row + q.rowSpan - 1 >= top);
  d.blocks[target].rect = clash ? { ...tRect, row: top, rowSpan: bottom - top + 1 } : wide;
  return {
    page: d,
    moved,
    resized,
    targetHeightMm: (bottom - top + 1) * rowMm,
    affected: new Set(inSec.map(({ i }) => i)),
  };
}
