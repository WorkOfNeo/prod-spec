import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canvasScale, CANVAS_BUDGET_PX } from "./canvas-scale";

// A 100 × 75 mm carton marking and a 40 × 30 mm care label — the two shapes
// the builder draws most.
const CARTON = { w: 100, h: 75 };
const CARE = { w: 40, h: 30 };

describe("canvasScale", () => {
  it("keeps the historic size when the column has the room it always had", () => {
    // 380/75 = 5.07 is the binding limit, exactly as before the panes moved.
    assert.equal(
      canvasScale(CARTON.w, CARTON.h, CANVAS_BUDGET_PX),
      Math.min(560 / 100, 380 / 75),
    );
  });

  it("never magnifies a small label past 6 px per mm", () => {
    assert.equal(canvasScale(CARE.w, CARE.h, CANVAS_BUDGET_PX), 6);
  });

  it("shrinks the page to fit a narrowed column", () => {
    // A 320 px column, less the 4 px gutter, over 100 mm.
    assert.equal(canvasScale(CARTON.w, CARTON.h, 320), 3.16);
  });

  it("stops shrinking at 1 px per mm so the column scrolls instead", () => {
    assert.equal(canvasScale(CARTON.w, CARTON.h, 60), 1);
  });

  it("holds the budget until the column has been measured", () => {
    for (const unmeasured of [0, Number.NaN, -20]) {
      assert.equal(
        canvasScale(CARTON.w, CARTON.h, unmeasured),
        canvasScale(CARTON.w, CARTON.h, CANVAS_BUDGET_PX),
        `width ${unmeasured} must fall back to the budget`,
      );
    }
  });

  it("takes the tighter of the two limits, whichever it is", () => {
    // Wide column, small label → the 6 px/mm cap binds.
    assert.equal(canvasScale(CARE.w, CARE.h, 2000), 6);
    // Narrow column, small label → the column binds.
    assert.equal(canvasScale(CARE.w, CARE.h, 84), 2);
  });

  it("falls back rather than dividing by a zero-sized page", () => {
    assert.equal(canvasScale(0, 0, 400), 3);
  });
});
