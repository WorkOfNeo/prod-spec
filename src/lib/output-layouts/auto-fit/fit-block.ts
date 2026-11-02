// Auto-fit: place one text block on a label face so it fits on every sample
// style, keeping it where it is and the layout as it is wherever possible.
// Read-only — it returns a proposed definition and never saves anything.
//
// Guard rails:
//   • A floor (minPt, 2.5 pt): nothing smaller is ever proposed.
//   • Keep-together phrases (a company name): glued with no-break spaces and
//     verified in the rendered page never to wrap across two lines.
//   • Position before size. The first placement that reaches the floor wins,
//     in this order; size only decides between options of the same kind:
//       1. in-place            today's cell, or the free space the cell sits
//                              in, text hugging the cell. Nothing else moves.
//       2. in-place-compacted  the blocks around it shrink to what they need
//                              and close up (order and columns kept); the
//                              text stays between the same neighbours.
//       3. elsewhere           a free band elsewhere on the face, nearest
//                              first. Nothing else moves.
//       4. other-side          compacted onto the other side of the fold.
//   • When nothing reaches the floor: OVERSHOOT — the most likely layout,
//     text at the floor, overflowing — plus the budget that says where the
//     section's millimetres go.
//
// How space is found: the face is rendered with the target emptied over every
// sample and ink is read back from the DOM (free bands = clear of ink, seams
// and the fold). Compaction refines the grid to ~1 mm rows, shrinks blocks to
// their worst-case need, re-renders every sample and gives an overflowing
// block rows back until it holds. "Worst case" is always over the samples:
// white space on one style is often the care text or a cert mark on another.

import type { StyleData } from "@/lib/pdf/types";
import { renderLayoutHtml, type LayoutRenderOptions } from "../render";
import { pageGrid, type LayoutBlock, type LayoutDef, type LayoutPage, type LayoutRect } from "../schema";
import { compactAround } from "./compact";
import {
  bandRows,
  DEFAULT_CLEAR_ZONES,
  freeBands,
  rectMm,
  refineGrid,
  rowHeightMm,
  sectionMm,
  sectionRows,
  simplifyGrid,
  type BandMm,
  type ClearZones,
  type InkBox,
  type RowSpan,
} from "./geometry";
import { keepPhrasesTogether, measurePage, type HtmlEvaluator, type PageMeasure } from "./measure";

export type AutoFitOptions = {
  // Floor: never proposed smaller. Below it the result is an overshoot.
  minPt: number;
  // Largest size the target may take. Default: the face's body text size
  // (composition / care block), clamped to 5–7 pt.
  capPt?: number;
  stepPt: number;
  // Phrases that must stay on one line, e.g. a company name.
  keepTogether: string[];
  gapMm: number;
  clear: ClearZones;
  inkClearMm: number;
  minBandMm: number;
  targetRowMm: number;
  // Size the overshoot proposal is drawn at. Default: minPt.
  overshootPt?: number;
  maxIterations: number;
  // Evaluate every placement (for a report) instead of stopping at the first
  // kind that fits. The choice is the same either way.
  exploreAll: boolean;
};

export const DEFAULT_AUTO_FIT_OPTIONS: AutoFitOptions = {
  minPt: 2.5,
  stepPt: 0.25,
  keepTogether: [],
  gapMm: 1,
  clear: DEFAULT_CLEAR_ZONES,
  inkClearMm: 0.8,
  minBandMm: 2.5,
  targetRowMm: 1.1,
  maxIterations: 8,
  exploreAll: false,
};

export const PLACEMENTS = ["in-place", "in-place-compacted", "elsewhere", "other-side"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type AutoFitSample = { styleData: StyleData; label: string };

export type AutoFitInput = {
  // The layout with the target block already holding its new text.
  def: LayoutDef;
  pageIndex: number;
  blockIndex: number;
  // Styles to fit against, worst case. samples[0] is the one to picture.
  samples: AutoFitSample[];
  evaluate: HtmlEvaluator;
  renderOptions?: Omit<LayoutRenderOptions, "mode" | "pageIndex">;
  options?: Partial<AutoFitOptions>;
};

export type FitCandidate = {
  placement: Placement;
  pt: number;
  page: LayoutPage;
  // How far the target's top moved from today's cell, mm.
  shiftMm: number;
  // Set when other blocks were compacted.
  compacted?: { moved: number; resized: number; iterations: number; targetHeightMm: number; sectionMm: number };
};

export type FitBudget = {
  // The target's section, between seam allowance and fold.
  sectionMm: number;
  // Height the target gets in the roomiest geometry.
  freeMm: number;
  // What the target needs at a few sizes, on samples[0].
  needAtMm: Record<number, number>;
  // Largest size that fits once the target's blank lines are dropped (may be
  // under the floor — it says how far off the floor is).
  noBlankPt: number;
  // Who else holds the section, largest first (worst-case heights).
  users: Array<{ block: number; firstLine: string; needMm: number; conditional: boolean }>;
  gapsMm: number;
  geometry: "kept" | "moved";
};

export type AutoFitResult = {
  // kept: no other block moved. moved: blocks were compacted.
  strategy: "kept" | "moved" | "overshoot";
  placement: Placement | null;
  // Size the target prints at in `def`.
  pt: number;
  capPt: number;
  def: LayoutDef;
  // Every placement evaluated that reaches the floor (first-fitting kind
  // only, unless exploreAll).
  candidates: FitCandidate[];
  budget: FitBudget | null;
  // For a space map: page-mm geometry of the face as measured.
  space: { sectionsMm: BandMm[]; ink: InkBox[]; freeBandsMm: BandMm[] };
  // Index into samples of the style whose other blocks print the most.
  fullestSample: number;
};

const FIT_TOLERANCE_MM = 0.2;
const OVERFLOW_TOLERANCE_MM = 0.3;
const CONDITIONAL_RE = /\{\{(cert|if)\b/;
const BODY_RE = /\{\{(composition|careInstructions)/;

// Largest value on the step grid lo, lo+step, …, hi for which fits() holds,
// or 0 when not even lo fits. fits() must be monotone (bigger text never
// fits where smaller didn't), which holds for a fixed box.
export async function largestFitting(lo: number, hi: number, step: number, fits: (pt: number) => Promise<boolean>) {
  const n = Math.floor((hi - lo) / step + 1e-9);
  if (n < 0 || !(await fits(lo))) return 0;
  let a = 0;
  let b = n + 1;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    if (await fits(lo + mid * step)) a = mid;
    else b = mid;
  }
  return Math.round((lo + a * step) * 100) / 100;
}

export function bodyCapPt(page: LayoutPage): number {
  const body = page.blocks.filter((b) => BODY_RE.test(b.lines.join(" "))).map((b) => b.fontPt);
  return Math.min(7, Math.max(5, body.length ? Math.max(...body) : 7));
}

// Pick from what was found: the first placement kind with a candidate wins;
// within a kind, "elsewhere" goes nearest first, the others largest first.
export function chooseCandidate(candidates: readonly FitCandidate[]): FitCandidate | null {
  for (const placement of PLACEMENTS) {
    const pool = candidates.filter((c) => c.placement === placement);
    if (!pool.length) continue;
    return [...pool].sort((a, z) =>
      placement === "elsewhere" ? a.shiftMm - z.shiftMm || z.pt - a.pt : z.pt - a.pt || a.shiftMm - z.shiftMm,
    )[0];
  }
  return null;
}

export async function autoFitBlock(input: AutoFitInput): Promise<AutoFitResult> {
  const o = { ...DEFAULT_AUTO_FIT_OPTIONS, ...input.options };
  const { pageIndex: pi, blockIndex: ti, samples } = input;
  if (!samples.length) throw new Error("autoFitBlock: no sample styles");
  if (!input.def.pages[pi]?.blocks[ti]?.rect) throw new Error(`autoFitBlock: page ${pi} block ${ti} is not a rect block`);

  // Keep-together phrases are glued in the definition itself, so the proposal
  // carries them.
  const def = structuredClone(input.def);
  const target0 = def.pages[pi].blocks[ti];
  target0.lines = target0.lines.map((l) => keepPhrasesTogether(l, o.keepTogether));

  const { page: page0 } = refineGrid(def.pages[pi], o.targetRowMm);
  const rowMm = rowHeightMm(page0);
  const capPt = o.capPt ?? bodyCapPt(page0);
  const floorPt = o.minPt;
  const targetLines = page0.blocks[ti].lines;
  const cell = rectMm(page0, page0.blocks[ti].rect!);
  const conditional = new Set(
    page0.blocks.map((b, i) => (i !== ti && CONDITIONAL_RE.test(b.lines.join(" ")) ? i : -1)).filter((i) => i >= 0),
  );

  const measure = async (page: LayoutPage, sd: StyleData, fitOff: boolean): Promise<PageMeasure> => {
    const d = structuredClone(def);
    d.pages[pi] = structuredClone(page);
    if (fitOff) for (const b of d.pages[pi].blocks) b.fitHeight = false;
    const html = await renderLayoutHtml(d, sd, { ...input.renderOptions, mode: "production", pageIndex: pi });
    return measurePage(input.evaluate, html, o.keepTogether);
  };
  const withTarget = (page: LayoutPage, patch: Partial<LayoutBlock>) => {
    const pg = structuredClone(page);
    pg.blocks[ti] = { ...pg.blocks[ti], fitHeight: false, ...patch };
    return pg;
  };
  // Does the target fit at `pt` on every sample, phrases unbroken?
  const fitsAll = (page: LayoutPage) => async (pt: number) => {
    const pg = withTarget(page, { fontPt: pt });
    for (const s of samples) {
      const n = (await measure(pg, s.styleData, true)).blocks[ti];
      if (!n || n.split || n.needMm > n.boxMm + FIT_TOLERANCE_MM) return false;
    }
    return true;
  };
  const largest = (page: LayoutPage) => largestFitting(floorPt, capPt, o.stepPt, fitsAll(page));
  const shiftOf = (page: LayoutPage) => Math.abs(rectMm(page, page.blocks[ti].rect!).top - cell.top);

  // ---- What the face holds -------------------------------------------------
  // Ink as printed, target emptied; blocks that print only on some styles
  // keep their whole cell.
  const empty = withTarget(page0, { lines: [] });
  const ink: InkBox[] = [];
  for (const s of samples) ink.push(...(await measure(empty, s.styleData, false)).ink);
  for (const i of conditional) {
    const r = page0.blocks[i].rect;
    if (r) ink.push({ block: i, ...rectMm(page0, r) });
  }
  const sections = sectionRows(page0, o.clear);
  const sectionsMm = sections.map((s) => sectionMm(page0, s));
  const allBands = freeBands(sectionsMm, ink, o.inkClearMm, o.minBandMm);
  const overlapsCell = ([a, b]: BandMm) => a < cell.bottom && b > cell.top;
  // Worst-case need of every block, and the sample whose other blocks print most.
  const worst = new Array<number>(page0.blocks.length).fill(0);
  const othersInk: number[] = [];
  for (const s of samples) {
    const m = await measure(withTarget(page0, { fontPt: floorPt }), s.styleData, true);
    m.blocks.forEach((n, i) => (worst[i] = Math.max(worst[i], n.needMm)));
    othersInk.push(m.blocks.reduce((sum, n, i) => sum + (i === ti ? 0 : n.needMm), 0));
  }
  const fullestSample = othersInk.indexOf(Math.max(...othersInk));
  const targetRow = page0.blocks[ti].rect!.row;
  const home = sections.find(([a, b]) => targetRow >= a && targetRow <= b) ?? sections[0];

  // ---- Placements, in order of preference ----------------------------------
  const { cols } = pageGrid(page0);
  const bandCandidate = async (band: BandMm, placement: Placement): Promise<FitCandidate | null> => {
    const rows = bandRows(page0, band);
    if (!rows) return null;
    const rect: LayoutRect = { col: 0, row: rows[0], colSpan: cols, rowSpan: rows[1] - rows[0] + 1 };
    // In place, the text hugs the side of the band its cell was on.
    const mid = (cell.top + cell.bottom) / 2;
    const third = (band[1] - band[0]) / 3;
    const valign =
      placement !== "in-place" ? "middle" : mid < band[0] + third ? "top" : mid > band[1] - third ? "bottom" : "middle";
    const page = withTarget(page0, { rect, valign });
    const pt = await largest(page);
    return pt ? { placement, pt, page: withTarget(page, { fontPt: pt }), shiftMm: round1(Math.abs(band[0] - cell.top)) } : null;
  };
  const compacted = async (sec: RowSpan, placement: Placement): Promise<FitCandidate | null> => {
    const extra = new Array<number>(page0.blocks.length).fill(0);
    for (let iter = 1; iter <= o.maxIterations; iter++) {
      const solved = compactAround(page0, ti, sec, worst.map((w, i) => w + extra[i]), {
        gapMm: o.gapMm,
        conditional,
        insertAtBottom: placement === "other-side",
      });
      if (!solved) return null;
      // Any block this pass touched that now overflows on some style gets rows back.
      let grow = false;
      const probe = withTarget(solved.page, { fontPt: floorPt });
      for (const s of samples) {
        const m = await measure(probe, s.styleData, true);
        m.blocks.forEach((n, i) => {
          if (i === ti || !solved.affected.has(i) || n.needMm <= n.boxMm + OVERFLOW_TOLERANCE_MM) return;
          extra[i] = Math.max(extra[i], n.needMm - n.boxMm + rowMm);
          grow = true;
        });
      }
      if (grow) continue;
      const pt = await largest(solved.page);
      if (!pt) return null;
      return {
        placement,
        pt,
        page: withTarget(solved.page, { fontPt: pt }),
        shiftMm: round1(shiftOf(solved.page)),
        compacted: {
          moved: solved.moved,
          resized: solved.resized,
          iterations: iter,
          targetHeightMm: round1(solved.targetHeightMm),
          sectionMm: round1((sec[1] - sec[0] + 1) * rowMm),
        },
      };
    }
    return null;
  };
  const steps: Record<Placement, () => Promise<Array<FitCandidate | null>>> = {
    "in-place": async () => {
      const todayPt = await largest(page0);
      const today = todayPt ? { placement: "in-place" as const, pt: todayPt, page: withTarget(page0, { fontPt: todayPt }), shiftMm: 0 } : null;
      const around = [];
      for (const b of allBands.filter(overlapsCell)) around.push(await bandCandidate(b, "in-place"));
      return [today, ...around];
    },
    "in-place-compacted": async () => [home ? await compacted(home, "in-place-compacted") : null],
    elsewhere: async () => {
      const out = [];
      for (const b of allBands.filter((b) => !overlapsCell(b)).slice(0, 5)) out.push(await bandCandidate(b, "elsewhere"));
      return out;
    },
    "other-side": async () => {
      const out = [];
      for (const sec of sections) {
        if (sec === home || (sec[1] - sec[0] + 1) * rowMm < 5) continue;
        out.push(await compacted(sec, "other-side"));
      }
      return out;
    },
  };
  const candidates: FitCandidate[] = [];
  for (const placement of PLACEMENTS) {
    for (const c of await steps[placement]()) if (c) candidates.push(c);
    if (!o.exploreAll && candidates.length) break;
  }
  const space = { sectionsMm, ink, freeBandsMm: allBands };

  const chosen = chooseCandidate(candidates);
  if (chosen) {
    return {
      strategy: chosen.compacted ? "moved" : "kept",
      placement: chosen.placement,
      pt: chosen.pt,
      capPt,
      // A safety net for styles outside the sample: fitHeight only acts on overflow.
      def: replacePage(def, pi, withTarget(chosen.page, { fitHeight: true })),
      candidates,
      budget: null,
      space,
      fullestSample,
    };
  }

  // ---- Overshoot: the most likely layout, and where the millimetres go ------
  const overshootPt = o.overshootPt ?? floorPt;
  const squeezed = compactAround(page0, ti, home, worst, { gapMm: o.gapMm, conditional });
  const cellMm = page0.blocks[ti].rect!.rowSpan * rowMm;
  const keepToday = !squeezed || cellMm >= squeezed.targetHeightMm;
  const geometry = keepToday ? page0 : squeezed.page;
  const base = samples[0].styleData;
  const needAtMm: Record<number, number> = {};
  for (const pt of [...new Set([floorPt, 3, 4])].sort((a, z) => a - z)) {
    needAtMm[pt] = round1((await measure(withTarget(geometry, { fontPt: pt, valign: "top" }), base, true)).blocks[ti].needMm);
  }
  const noBlank = withTarget(geometry, { lines: targetLines.filter((l) => l.trim()), valign: "top" });
  const noBlankPt = await largestFitting(1, capPt, o.stepPt, async (pt) => {
    const n = (await measure(withTarget(noBlank, { fontPt: pt }), base, true)).blocks[ti];
    return !n.split && n.needMm <= n.boxMm + FIT_TOLERANCE_MM;
  });
  const users = page0.blocks
    .map((b, i) => ({ b, i }))
    .filter(
      ({ b, i }) =>
        i !== ti && b.rect && b.lines.some((l) => l.trim()) && b.rect.row >= home[0] && b.rect.row + b.rect.rowSpan - 1 <= home[1],
    )
    .map(({ b, i }) => ({
      block: i,
      firstLine: (b.lines.find((l) => l.trim()) ?? "").trim(),
      needMm: round1(conditional.has(i) ? Math.max(b.rect!.rowSpan * rowMm, worst[i]) : worst[i]),
      conditional: conditional.has(i),
    }))
    .sort((a, z) => z.needMm - a.needMm);
  return {
    strategy: "overshoot",
    placement: null,
    pt: overshootPt,
    capPt,
    def: replacePage(def, pi, withTarget(geometry, { fontPt: overshootPt, valign: "top" })),
    candidates,
    budget: {
      sectionMm: round1((home[1] - home[0] + 1) * rowMm),
      freeMm: round1(keepToday ? cellMm : squeezed.targetHeightMm),
      needAtMm,
      noBlankPt,
      users,
      gapsMm: round1(users.length * o.gapMm),
      geometry: keepToday ? "kept" : "moved",
    },
    space,
    fullestSample,
  };
}

function replacePage(def: LayoutDef, pageIndex: number, page: LayoutPage): LayoutDef {
  const d = structuredClone(def);
  d.pages[pageIndex] = simplifyGrid(page);
  return d;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
