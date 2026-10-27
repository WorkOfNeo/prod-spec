// What a rendered label face actually prints — measured in the browser.
//
// The solver never guesses text heights from font metrics: it renders the
// face through the production renderer and reads the DOM back. One script
// returns, per block, the height its lines need and the height its box has,
// plus the page-mm box of every printed line (the "ink"). The DOM gives exact
// boxes, so no vision model is needed to see where text lands.

import type { InkBox } from "./geometry";

export type BlockMeasure = { needMm: number; boxMm: number };
export type PageMeasure = { blocks: BlockMeasure[]; ink: InkBox[] };

// Loads one rendered document (exactly as the PDF path loads it) and runs a
// script in it. `openMeasurePage` in src/lib/pdf/renderer.ts is the real one;
// tests can pass a fake.
export type HtmlEvaluator = <T>(html: string, script: string) => Promise<T>;

// Kept as a string, not a function: callers run under tsx/esbuild, which
// injects helpers into serialised functions that don't exist in the page.
export const MEASURE_PAGE_JS = `(function () {
  var page = document.querySelector(".ol-page");
  if (!page) return { blocks: [], ink: [] };
  var pr = page.getBoundingClientRect(), mm = 25.4 / 96, ink = [];
  var blocks = Array.prototype.map.call(page.querySelectorAll(".ol-block"), function (b, bi) {
    var h = 0, any = false;
    Array.prototype.forEach.call(b.children, function (l) {
      var r = l.getBoundingClientRect();
      h += r.height;
      var txt = (l.textContent || "").replace(/\\u00a0/g, " ").trim();
      if ((!txt && !l.querySelector("img,svg,canvas")) || r.height <= 0) return;
      any = true;
      ink.push({ block: bi, top: (r.top - pr.top) * mm, bottom: (r.bottom - pr.top) * mm,
                 left: (r.left - pr.left) * mm, right: (r.right - pr.left) * mm });
    });
    var cs = getComputedStyle(b);
    var extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
                parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    return { needMm: any ? (h + extra) * mm : 0, boxMm: b.getBoundingClientRect().height * mm };
  });
  return { blocks: blocks, ink: ink };
})()`;

export async function measurePage(evaluate: HtmlEvaluator, html: string): Promise<PageMeasure> {
  return evaluate<PageMeasure>(html, MEASURE_PAGE_JS);
}
