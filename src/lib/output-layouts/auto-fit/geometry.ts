// Page geometry for the auto-fit solver — pure, no rendering.
//
// Everything here works in two units: GRID ROWS (what a block's rect is
// stored in) and PAGE MILLIMETRES (what the renderer measures ink in). The
// helpers convert between them the same way renderBlock places a rect, so a
// band found in measured ink maps back onto exactly the rows that print there.

import { LAYOUT_GRID_MAX, pageGrid, type LayoutPage, type LayoutRect } from "../schema";

export type BandMm = [top: number, bottom: number];
export type RowSpan = [first: number, last: number];

// Where a printed line landed, in page mm. `block` is the index into
// page.blocks (the renderer emits one .ol-block per block, in order).
export type InkBox = { block: number; top: number; bottom: number; left: number; right: number };

export type ClearZones = {
  // Kept clear past each sewing line, towards the content (the seam allowance
  // swallows anything printed right on it).
  seamClearMm: number;
  // Kept clear either side of a horizontal fold.
  foldClearMm: number;
};

export const DEFAULT_CLEAR_ZONES: ClearZones = { seamClearMm: 1, foldClearMm: 1.5 };

function margins(page: LayoutPage) {
  return page.margins ?? { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 };
}

export function rowHeightMm(page: LayoutPage): number {
  const m = margins(page);
  return (page.heightMm - m.topMm - m.bottomMm) / pageGrid(page).rows;
}

export function rowTopMm(page: LayoutPage, row: number): number {
  return margins(page).topMm + row * rowHeightMm(page);
}

export function rectMm(page: LayoutPage, rect: LayoutRect): { top: number; bottom: number; left: number; right: number } {
  const m = margins(page);
  const { cols } = pageGrid(page);
  const innerW = page.widthMm - m.leftMm - m.rightMm;
  return {
    top: rowTopMm(page, rect.row),
    bottom: rowTopMm(page, rect.row + rect.rowSpan),
    left: m.leftMm + (innerW * rect.col) / cols,
    right: m.leftMm + (innerW * (rect.col + rect.colSpan)) / cols,
  };
}

// Split every grid row into k exact sub-rows so blocks can move in ~1 mm
// steps. Nothing moves: each rect is scaled by the same k, so the page prints
// identically. k stays an integer (exact) and the grid stays within
// LAYOUT_GRID_MAX.
export function refineGrid(page: LayoutPage, targetRowMm = 1.1): { page: LayoutPage; factor: number } {
  const p = structuredClone(page);
  const { cols, rows } = pageGrid(p);
  let k = Math.max(1, Math.ceil(rowHeightMm(p) / targetRowMm));
  while (rows * k > LAYOUT_GRID_MAX && k > 1) k--;
  p.gridCols = cols;
  p.gridRows = rows * k;
  for (const b of p.blocks) if (b.rect) b.rect = { ...b.rect, row: b.rect.row * k, rowSpan: b.rect.rowSpan * k };
  return { page: p, factor: k };
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// The inverse of refineGrid once the solver is done: divide the row grid by
// the largest factor every rect still shares, so a layout the solver barely
// touched comes back on (close to) the grid it was authored on.
export function simplifyGrid(page: LayoutPage): LayoutPage {
  const p = structuredClone(page);
  const { rows } = pageGrid(p);
  let g = rows;
  for (const b of p.blocks) if (b.rect) g = gcd(gcd(g, b.rect.row), b.rect.rowSpan);
  if (g <= 1) return p;
  p.gridRows = rows / g;
  for (const b of p.blocks) if (b.rect) b.rect = { ...b.rect, row: b.rect.row / g, rowSpan: b.rect.rowSpan / g };
  return p;
}

// The bands nothing may print in: past each sewing line and around a
// horizontal fold. A vertical fold splits the page sideways, which this
// row-based solver does not model.
export function reservedZonesMm(page: LayoutPage, clear: ClearZones = DEFAULT_CLEAR_ZONES): BandMm[] {
  const zones: BandMm[] = [];
  for (const s of page.sewingLines ?? []) {
    if (s.edge === "top") zones.push([0, s.offsetMm + clear.seamClearMm]);
    else zones.push([page.heightMm - s.offsetMm - clear.seamClearMm, page.heightMm]);
  }
  if (page.foldLine === "horizontal") {
    zones.push([page.heightMm / 2 - clear.foldClearMm, page.heightMm / 2 + clear.foldClearMm]);
  }
  return zones;
}

// The runs of whole grid rows clear of every reserved zone — on a folded care
// label, one section per face.
export function sectionRows(page: LayoutPage, clear: ClearZones = DEFAULT_CLEAR_ZONES): RowSpan[] {
  const { rows } = pageGrid(page);
  const rowMm = rowHeightMm(page);
  const zones = reservedZonesMm(page, clear);
  const free = Array.from({ length: rows }, (_, r) => {
    const y0 = rowTopMm(page, r);
    return !zones.some(([a, b]) => y0 < b - 0.01 && y0 + rowMm > a + 0.01);
  });
  const out: RowSpan[] = [];
  for (let r = 0; r < rows; r++) {
    if (!free[r]) continue;
    let e = r;
    while (e + 1 < rows && free[e + 1]) e++;
    out.push([r, e]);
    r = e;
  }
  return out;
}

export function sectionMm(page: LayoutPage, [first, last]: RowSpan): BandMm {
  return [rowTopMm(page, first), rowTopMm(page, last + 1)];
}

// Vertical bands inside the sections that stay `clearanceMm` away from any
// ink, tallest first. This is "where could text go without moving anything".
export function freeBands(sections: BandMm[], ink: InkBox[], clearanceMm = 0.8, minHeightMm = 2.5): BandMm[] {
  const bands: BandMm[] = [];
  for (const [y0, y1] of sections) {
    const blocked = ink
      .map((b) => [b.top - clearanceMm, b.bottom + clearanceMm] as BandMm)
      .filter(([a, b]) => b > y0 && a < y1)
      .sort((p, q) => p[0] - q[0]);
    let cur = y0;
    for (const [a, b] of blocked) {
      if (a > cur) bands.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < y1) bands.push([cur, y1]);
  }
  return bands.filter(([a, b]) => b - a >= minHeightMm).sort((p, q) => q[1] - q[0] - (p[1] - p[0]));
}

// The whole grid rows inside a mm band (rounded inwards), or null when the
// band is thinner than one row.
export function bandRows(page: LayoutPage, [top, bottom]: BandMm): RowSpan | null {
  const m = margins(page);
  const rowMm = rowHeightMm(page);
  const r0 = Math.ceil((top - m.topMm) / rowMm - 1e-6);
  const r1 = Math.floor((bottom - m.topMm) / rowMm + 1e-6) - 1;
  return r1 < r0 ? null : [r0, r1];
}
