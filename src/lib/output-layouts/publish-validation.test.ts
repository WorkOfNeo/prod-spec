import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLayoutForPublish } from "./publish-validation";

// The one gate both the Output Builder's Publish button and publishRevision()
// go through. Synthetic 50×60 mm sticker on a 4 mm grid.

function def(lines: string[][]) {
  return {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 12,
        gridRows: 15,
        blocks: lines.map((l, i) => ({
          id: `b${i}`,
          rect: { col: 0, row: i, colSpan: 12, rowSpan: 1 },
          lines: l,
        })),
      },
    ],
  };
}

test("a clean layout passes and comes back schema-parsed", () => {
  const res = validateLayoutForPublish(
    def([["{{styleNumber}}"], ['{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}'], ["{{= 2 * 3 }}"]]),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Defaults are filled by the schema parse (fontPt default 9).
  assert.equal(res.def.pages[0]?.blocks[0]?.fontPt, 9);
});

test("a shape the schema rejects is 'definition is invalid'", () => {
  const res = validateLayoutForPublish({ pages: [] });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error, "Layout definition is invalid");
  assert.ok(res.details.length > 0);
});

test("non-objects are invalid, never silently replaced by a starter layout", () => {
  for (const raw of [null, "x", 42, {}]) {
    const res = validateLayoutForPublish(raw);
    assert.equal(res.ok, false, `input ${JSON.stringify(raw)}`);
  }
});

test("unknown variables block publish", () => {
  const res = validateLayoutForPublish(def([["{{noSuchToken}}"]]));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error, "Layout can't be published");
  assert.ok(res.details.some((d) => d.includes("noSuchToken")), res.details.join("; "));
});

test("malformed conditionals and calcs block publish", () => {
  const cond = validateLayoutForPublish(def([['{{if styleNumber == "X"}}yes']]));
  assert.equal(cond.ok, false);
  const calc = validateLayoutForPublish(def([["{{= 2 * }}"]]));
  assert.equal(calc.ok, false);
});

test("a layout with no blocks blocks publish", () => {
  const res = validateLayoutForPublish(def([]));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.deepEqual(res.details, ["layout has no blocks — nothing would print"]);
});
