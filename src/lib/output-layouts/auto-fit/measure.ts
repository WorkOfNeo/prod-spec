// What a rendered label face actually prints — measured in the browser.
//
// The solver never guesses text heights from font metrics: it renders the
// face through the production renderer and reads the DOM back. One script
// returns, per block, the height its lines need and the height its box has,
// plus the page-mm box of every printed line (the "ink"). The DOM gives exact
// boxes, so no vision model is needed to see where text lands.

import type { InkBox } from "./geometry";

// `split`: a keep-together phrase in this block wraps onto two lines.
export type BlockMeasure = { needMm: number; boxMm: number; split: boolean };
export type PageMeasure = { blocks: BlockMeasure[]; ink: InkBox[] };

// Loads one rendered document (exactly as the PDF path loads it) and runs a
// script in it. `openMeasurePage` in src/lib/pdf/renderer.ts is the real one;
// tests can pass a fake.
export type HtmlEvaluator = <T>(html: string, script: string) => Promise<T>;

// Kept as a string, not a function: callers run under tsx/esbuild, which
// injects helpers into serialised functions that don't exist in the page.
// __PHRASES__ is replaced with a JSON array of keep-together phrases.
const MEASURE_TEMPLATE = `(function () {
  var page = document.querySelector(".ol-page");
  if (!page) return { blocks: [], ink: [] };
  var pr = page.getBoundingClientRect(), mm = 25.4 / 96, ink = [], phrases = __PHRASES__;
  var norm = function (s) { return s.replace(/\\u00a0/g, " "); };
  // Does any phrase occurrence in this block cover more than one line box?
  function split(b) {
    if (!phrases.length) return false;
    var walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT), node;
    while ((node = walk.nextNode())) {
      var text = norm(node.nodeValue || "");
      for (var p = 0; p < phrases.length; p++) {
        var at = text.indexOf(phrases[p]);
        while (at >= 0) {
          var range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + phrases[p].length);
          var tops = {};
          Array.prototype.forEach.call(range.getClientRects(), function (r) {
            if (r.width > 0) tops[Math.round(r.top)] = true;
          });
          if (Object.keys(tops).length > 1) return true;
          at = text.indexOf(phrases[p], at + 1);
        }
      }
    }
    return false;
  }
  var blocks = Array.prototype.map.call(page.querySelectorAll(".ol-block"), function (b, bi) {
    var h = 0, any = false;
    Array.prototype.forEach.call(b.children, function (l) {
      var r = l.getBoundingClientRect();
      h += r.height;
      var txt = norm(l.textContent || "").trim();
      if ((!txt && !l.querySelector("img,svg,canvas")) || r.height <= 0) return;
      any = true;
      ink.push({ block: bi, top: (r.top - pr.top) * mm, bottom: (r.bottom - pr.top) * mm,
                 left: (r.left - pr.left) * mm, right: (r.right - pr.left) * mm });
    });
    var cs = getComputedStyle(b);
    var extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
                parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    return { needMm: any ? (h + extra) * mm : 0, boxMm: b.getBoundingClientRect().height * mm, split: split(b) };
  });
  return { blocks: blocks, ink: ink };
})()`;

export function measurePageJs(keepTogether: readonly string[] = []): string {
  return MEASURE_TEMPLATE.replace("__PHRASES__", JSON.stringify(keepTogether.map((p) => p.replace(/ /g, " "))));
}

export const MEASURE_PAGE_JS = measurePageJs();

export async function measurePage(
  evaluate: HtmlEvaluator,
  html: string,
  keepTogether: readonly string[] = [],
): Promise<PageMeasure> {
  return evaluate<PageMeasure>(html, keepTogether.length ? measurePageJs(keepTogether) : MEASURE_PAGE_JS);
}

// Glue a phrase's words with no-break spaces wherever it appears, so the
// browser wraps before or after it, never inside.
export function keepPhrasesTogether(line: string, keepTogether: readonly string[]): string {
  let out = line;
  for (const phrase of keepTogether) {
    const words = phrase.trim().split(/\s+/);
    if (words.length < 2) continue;
    const loose = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ \\u00a0]+"), "g");
    out = out.replace(loose, words.join(" "));
  }
  return out;
}
