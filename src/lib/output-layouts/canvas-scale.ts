// =====================================================
// How many screen pixels one millimetre of the drawn page is worth in the
// Output Builder canvas.
//
// Two limits, and the tighter one wins:
//   • the historic budget — the canvas was sized to sit inside a ~560 × 380
//     px area, never magnified past 6 px/mm (a 20 mm care label would
//     otherwise fill the screen) and never reduced below 1 px/mm;
//   • the width the canvas column actually has, now that the column is
//     resizable — dragging the inspector wider shrinks the page to match
//     instead of pushing it out of the pane.
//
// Kept out of the editor component so the arithmetic is testable on its own;
// the component only supplies the measured width.
// =====================================================

// The area the canvas was laid out against when the three columns were fixed.
export const CANVAS_BUDGET_PX = 560;
const CANVAS_BUDGET_H_PX = 380;
// Never magnify past this, and never shrink below 1 px/mm — under that the
// page is unreadable, so the column scrolls instead.
const MAX_SCALE = 6;
const MIN_SCALE = 1;
// Breathing room so a page never sits flush against the column's edge.
const GUTTER_PX = 4;

export function canvasScale(widthMm: number, heightMm: number, availWidthPx: number): number {
  if (!(widthMm > 0) || !(heightMm > 0)) return 3;
  const budget = Math.min(
    Math.max(Math.min(CANVAS_BUDGET_PX / widthMm, CANVAS_BUDGET_H_PX / heightMm), MIN_SCALE),
    MAX_SCALE,
  );
  // An unmeasured column (0, NaN) must not collapse the canvas — fall back
  // to the budget until the observer reports a real width.
  if (!(availWidthPx > 0)) return budget;
  const fit = Math.max((availWidthPx - GUTTER_PX) / widthMm, MIN_SCALE);
  return Math.min(budget, fit);
}
