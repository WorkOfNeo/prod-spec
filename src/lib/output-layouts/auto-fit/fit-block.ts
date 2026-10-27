// Auto-fit: give one text block on a label face the largest size it can print
// at, preserving the layout as much as possible. Read-only — it returns a
// proposed definition and never saves anything.
//
// Three tiers, cheapest change first:
//
//   1. KEEP THE LAYOUT. Render the face with the target emptied over every
//      sample style and read where ink really lands. Whatever stays clear of
//      ink, seams and the fold is a free band; the target goes in the band
//      where it prints largest. Today's own cell competes too. Nothing moves.
//   2. MOVE BLOCKS. Refine the grid to ~1 mm rows, shrink every block in the
//      target's section to its worst-case need, slide the blocks above up and
//      below down (order and columns kept), stretch the target full width over
//      what that frees, then re-render every sample: a block that overflows gets
//      rows back and the loop runs again. The other side of the fold is tried
//      too. Moving only wins when it gains enough over keeping.
//   3. OVERSHOOT. When neither reaches a readable size, still return the most
//      likely solution — the roomiest geometry with the target at a readable
//      size, overflowing — plus the budget that says where the millimetres go.
//
// "Worst case" is always over the sample styles: white space on one style is
// often the care text or a cert mark on another.

import type { StyleData } from "@/lib/pdf/types";
import { renderLayoutHtml, type LayoutRenderOptions } from "../render";
import { pageGrid, type LayoutDef, type LayoutPage, type LayoutRect } from "../schema";
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
} from "./geometry";
import { measurePage, type HtmlEvaluator, type PageMeasure } from "./measure";

export type AutoFitOptions = {
  minPt: number;
  // Largest size the target may take. Default: the face's body text size
  // (composition / care block), clamped to 5–7 pt.
  capPt?: number;
  stepPt: number;
  gapMm: number;
  clear: ClearZones;
  inkClearMm: number;
  minBandMm: number;
  targetRowMm: number;
  // Keeping the layout is the answer at or above this size…
  goodEnoughPt: number;
  // …and below it, moving blocks must gain at least this much to win.
  moveMustGainPt: number;
  // Below this, the result is an overshoot proposal.
  readablePt: number;
  overshootPt: number;
  maxIterations: number;
};

export const DEFAULT_AUTO_FIT_OPTIONS: AutoFitOptions = {
  minPt: 2,
  stepPt: 0.25,
  gapMm: 1,
  clear: DEFAULT_CLEAR_ZONES,
  inkClearMm: 0.8,
  minBandMm: 2.5,
  targetRowMm: 1.1,
  goodEnoughPt: 5,
  moveMustGainPt: 0.5,
  readablePt: 3,
  overshootPt: 4,
  maxIterations: 8,
};

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

export type FitCandidate = { pt: number; page: LayoutPage };
export type MovedCandidate = FitCandidate & {
  iterations: number;
  moved: number;
  resized: number;
  otherSide: boolean;
  targetHeightMm: number;
  sectionMm: number;
};
export type FitBudget = {
  // The target's section, between seam allowance and fold.
  sectionMm: number;
  // Height the target gets in the roomiest geometry.
  freeMm: number;
  // What the target needs at a few sizes, on samples[0].
  needAtMm: Record<number, number>;
  // Largest size that fits once the target's blank lines are dropped.
  noBlankPt: number;
  // Who else holds the section, largest first (worst-case heights).
  users: Array<{ block: number; firstLine: string; needMm: number; conditional: boolean }>;
  gapsMm: number;
  geometry: "kept" | "moved";
};

export type AutoFitResult = {
  strategy: "kept" | "moved" | "overshoot";
  // Size the target prints at in `def`.
  pt: number;
  capPt: number;
  def: LayoutDef;
  candidates: { band: FitCandidate | null; today: FitCandidate | null; moved: MovedCandidate | null };
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

export async function autoFitBlock(input: AutoFitInput): Promise<AutoFitResult> {
  const o = { ...DEFAULT_AUTO_FIT_OPTIONS, ...input.options };
  const { def, pageIndex: pi, blockIndex: ti, samples } = input;
  if (!samples.length) throw new Error("autoFitBlock: no sample styles");
  const original = def.pages[pi];
  if (!original?.blocks[ti]?.rect) throw new Error(`autoFitBlock: page ${pi} block ${ti} is not a rect block`);

  const { page: page0 } = refineGrid(original, o.targetRowMm);
  const rowMm = rowHeightMm(page0);
  const capPt = o.capPt ?? bodyCapPt(page0);
  const targetLines = page0.blocks[ti].lines;
  const conditional = new Set(
    page0.blocks.map((b, i) => (i !== ti && CONDITIONAL_RE.test(b.lines.join(" ")) ? i : -1)).filter((i) => i >= 0),
  );

  const measure = async (page: LayoutPage, sd: StyleData, fitOff: boolean): Promise<PageMeasure> => {
    const d = structuredClone(def);
    d.pages[pi] = structuredClone(page);
    if (fitOff) for (const b of d.pages[pi].blocks) b.fitHeight = false;
    const html = await renderLayoutHtml(d, sd, { ...input.renderOptions, mode: "production", pageIndex: pi });
    return measurePage(input.evaluate, html);
  };
  const withTarget = (page: LayoutPage, patch: Partial<LayoutPage["blocks"][number]>) => {
    const pg = structuredClone(page);
    pg.blocks[ti] = { ...pg.blocks[ti], fitHeight: false, ...patch };
    return pg;
  };
  // Does the target fit at `pt` on every sample?
  const fitsAll = (page: LayoutPage) => async (pt: number) => {
    const pg = withTarget(page, { fontPt: pt });
    for (const s of samples) {
      const n = (await measure(pg, s.styleData, true)).blocks[ti];
      if (!n || n.needMm > n.boxMm + FIT_TOLERANCE_MM) return false;
    }
    return true;
  };
  const largest = (page: LayoutPage) => largestFitting(o.minPt, capPt, o.stepPt, fitsAll(page));

  // ---- Tier 1: keep the layout -------------------------------------------
  const empty = withTarget(page0, { lines: [] });
  const ink: InkBox[] = [];
  for (const s of samples) ink.push(...(await measure(empty, s.styleData, false)).ink);
  // A block that prints only on some styles keeps its whole cell.
  for (const i of conditional) {
    const r = page0.blocks[i].rect;
    if (r) ink.push({ block: i, ...rectMm(page0, r) });
  }
  const sections = sectionRows(page0, o.clear);
  const sectionsMm = sections.map((s) => sectionMm(page0, s));
  const bands = freeBands(sectionsMm, ink, o.inkClearMm, o.minBandMm).slice(0, 5);
  const { cols } = pageGrid(page0);
  const targetTopMm = rectMm(page0, page0.blocks[ti].rect!).top;
  let band: (FitCandidate & { distance: number }) | null = null;
  for (const b of bands) {
    const rows = bandRows(page0, b);
    if (!rows) continue;
    const rect: LayoutRect = { col: 0, row: rows[0], colSpan: cols, rowSpan: rows[1] - rows[0] + 1 };
    const page = withTarget(page0, { rect, valign: "middle" });
    const pt = await largest(page);
    const distance = Math.abs(b[0] - targetTopMm);
    if (pt && (!band || pt > band.pt || (pt === band.pt && distance < band.distance))) {
      band = { pt, page: withTarget(page, { fontPt: pt }), distance };
    }
  }
  const todayPt = await largest(page0);
  const today: FitCandidate | null = todayPt ? { pt: todayPt, page: withTarget(page0, { fontPt: todayPt }) } : null;

  // ---- Tier 2: move blocks -------------------------------------------------
  const worst = new Array<number>(page0.blocks.length).fill(0);
  const othersInk: number[] = [];
  const atMin = withTarget(page0, { fontPt: o.minPt });
  for (const s of samples) {
    const m = await measure(atMin, s.styleData, true);
    m.blocks.forEach((n, i) => (worst[i] = Math.max(worst[i], n.needMm)));
    othersInk.push(m.blocks.reduce((sum, n, i) => sum + (i === ti ? 0 : n.needMm), 0));
  }
  const fullestSample = othersInk.indexOf(Math.max(...othersInk));
  const targetRow = page0.blocks[ti].rect!.row;
  const home = sections.find(([a, b]) => targetRow >= a && targetRow <= b) ?? sections[0];

  let moved: MovedCandidate | null = null;
  for (const sec of sections) {
    if ((sec[1] - sec[0] + 1) * rowMm < 5) continue;
    const atHome = sec === home;
    const extra = new Array<number>(page0.blocks.length).fill(0);
    for (let iter = 1; iter <= o.maxIterations; iter++) {
      const solved = compactAround(page0, ti, sec, worst.map((w, i) => w + extra[i]), {
        gapMm: o.gapMm,
        conditional,
        insertAtBottom: !atHome,
      });
      if (!solved) break;
      // Any block this pass touched that now overflows on some style gets rows back.
      let grow = false;
      const probe = withTarget(solved.page, { fontPt: o.minPt });
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
      const better = !moved || pt > moved.pt || (pt === moved.pt && atHome);
      if (pt && better) {
        moved = {
          pt,
          page: withTarget(solved.page, { fontPt: pt }),
          iterations: iter,
          moved: solved.moved,
          resized: solved.resized,
          otherSide: !atHome,
          targetHeightMm: round1(solved.targetHeightMm),
          sectionMm: round1((sec[1] - sec[0] + 1) * rowMm),
        };
      }
      break;
    }
  }
  // Moving things must beat leaving them where they are.
  if (moved && moved.pt <= todayPt) moved = null;

  // ---- Decide --------------------------------------------------------------
  const kept = [band, today].filter((c): c is FitCandidate => !!c).sort((a, z) => z.pt - a.pt)[0] ?? null;
  const keptPt = kept?.pt ?? 0;
  const movedPt = moved?.pt ?? 0;
  const choice =
    keptPt >= o.goodEnoughPt || movedPt < keptPt + o.moveMustGainPt ? (kept ? "kept" : moved ? "moved" : null) : "moved";
  const chosen = choice === "kept" ? kept : choice === "moved" ? moved : null;
  const candidates = { band: band && { pt: band.pt, page: band.page }, today, moved };
  const space = { sectionsMm, ink, freeBandsMm: bands };

  if (chosen && chosen.pt >= o.readablePt) {
    return {
      strategy: choice!,
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

  // ---- Tier 3: overshoot -----------------------------------------------------
  const compacted = compactAround(page0, ti, home, worst, { gapMm: o.gapMm, conditional });
  const cellMm = page0.blocks[ti].rect!.rowSpan * rowMm;
  const keepToday = !compacted || cellMm >= compacted.targetHeightMm;
  const geometry = keepToday ? page0 : compacted.page;
  const freeMm = keepToday ? cellMm : compacted.targetHeightMm;
  const base = samples[0].styleData;
  const needAtMm: Record<number, number> = {};
  for (const pt of [3, 4, 5]) {
    needAtMm[pt] = round1((await measure(withTarget(geometry, { fontPt: pt, valign: "top" }), base, true)).blocks[ti].needMm);
  }
  const noBlank = withTarget(geometry, { lines: targetLines.filter((l) => l.trim()), valign: "top" });
  const noBlankPt = await largestFitting(1, capPt, o.stepPt, async (pt) => {
    const n = (await measure(withTarget(noBlank, { fontPt: pt }), base, true)).blocks[ti];
    return n.needMm <= n.boxMm + FIT_TOLERANCE_MM;
  });
  const users = page0.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b, i }) => i !== ti && b.rect && b.lines.some((l) => l.trim()) && b.rect.row >= home[0] && b.rect.row + b.rect.rowSpan - 1 <= home[1])
    .map(({ b, i }) => ({
      block: i,
      firstLine: (b.lines.find((l) => l.trim()) ?? "").trim(),
      needMm: round1(conditional.has(i) ? Math.max(b.rect!.rowSpan * rowMm, worst[i]) : worst[i]),
      conditional: conditional.has(i),
    }))
    .sort((a, z) => z.needMm - a.needMm);
  return {
    strategy: "overshoot",
    pt: o.overshootPt,
    capPt,
    def: replacePage(def, pi, withTarget(geometry, { fontPt: o.overshootPt, valign: "top" })),
    candidates,
    budget: {
      sectionMm: round1((home[1] - home[0] + 1) * rowMm),
      freeMm: round1(freeMm),
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

