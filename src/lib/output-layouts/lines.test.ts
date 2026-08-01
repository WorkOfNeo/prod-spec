import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";
import type { LayoutDef } from "./schema";

// render.ts / tokens.ts transitively import @/lib/db, whose client construction
// needs DATABASE_URL at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let documentLines: typeof import("./lines").documentLines;
let resolveLinePlain: typeof import("./lines").resolveLinePlain;
let lineOverrideKey: typeof import("./line-keys").lineOverrideKey;
let isLineKey: typeof import("./line-keys").isLineKey;
let mergeLineValues: typeof import("../outputs/output-line-values").mergeLineValues;
let splitLineValues: typeof import("../outputs/output-line-values").splitLineValues;
let parseLayoutDef: typeof import("./schema").parseLayoutDef;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ documentLines, resolveLinePlain } = await import("./lines"));
  ({ lineOverrideKey, isLineKey } = await import("./line-keys"));
  ({ mergeLineValues, splitLineValues } = await import("../outputs/output-line-values"));
  ({ parseLayoutDef } = await import("./schema"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// A two-line carton block shaped like the live Dollarstore layout that started
// this: one HARDCODED literal, one token line.
function def(lines: string[] = ["Inner box: 8 pair", "Outer box: {{qtyPerCarton}} pair"]): LayoutDef {
  return parseLayoutDef({
    pages: [
      {
        id: "p1",
        title: "Front",
        widthMm: 100,
        heightMm: 100,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 }, lines }],
      },
    ],
  });
}

function style(cartonQtyRaw?: string): StyleData {
  const s = buildSampleStyleData();
  return { ...s, cartonQtyRaw, carton: { ...s.carton, outerVE: cartonQtyRaw ? 0 : s.carton.outerVE } };
}

test("every line is addressable — including a hardcoded literal no field backs", () => {
  const rows = documentLines(def(), style("Solid= 5/20"), undefined);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lineKey, lineOverrideKey("p1", "b1", 0));
  assert.equal(rows[1].lineKey, lineOverrideKey("p1", "b1", 1));
  // The literal has no token at all — the case the field editor can never reach.
  assert.equal(rows[0].authored, "Inner box: 8 pair");
  assert.equal(rows[0].resolved, "Inner box: 8 pair");
  assert.equal(rows[0].kind, "text");
  assert.equal(rows[0].overridden, false);
});

test("resolved text reflects the style, so a reviewer can find the line they mean", () => {
  // "Solid= 5/20" is a pack pair → bare {{qtyPerCarton}} takes the INNER number.
  const rows = documentLines(def(), style("Solid= 5/20"), undefined);
  assert.equal(rows[1].resolved, "Outer box: 5 pair");
});

test("an override replaces the source line and is reported as edited", () => {
  const key = lineOverrideKey("p1", "b1", 0);
  const rows = documentLines(def(), style("Solid= 5/20"), { [key]: "Inner box: 5 pair" });
  assert.equal(rows[0].source, "Inner box: 5 pair");
  assert.equal(rows[0].resolved, "Inner box: 5 pair");
  assert.equal(rows[0].overridden, true);
  // …while `authored` still carries the layout's own text, so the editor can
  // offer "revert" and detect an edit back to the original.
  assert.equal(rows[0].authored, "Inner box: 8 pair");
});

test("an override is a SOURCE line — tokens inside it still resolve", () => {
  const key = lineOverrideKey("p1", "b1", 0);
  const rows = documentLines(def(), style("Solid= 5/20"), {
    [key]: "Inner box: {{qtyPerCarton:inner}} pair",
  });
  assert.equal(rows[0].resolved, "Inner box: 5 pair");
  // And the outer line can be repointed the same way.
  const rows2 = documentLines(def(), style("Solid= 5/20"), {
    [lineOverrideKey("p1", "b1", 1)]: "Outer box: {{qtyPerCarton:outer}} pair",
  });
  assert.equal(rows2[1].resolved, "Outer box: 20 pair");
});

test("a blank layout spacer is offered too — a reviewer can add a line that never existed", () => {
  const rows = documentLines(def(["", "Text"]), style(), undefined);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].authored, "");
  const rows2 = documentLines(def(["", "Text"]), style(), {
    [lineOverrideKey("p1", "b1", 0)]: "Added by reviewer",
  });
  assert.equal(rows2[0].resolved, "Added by reviewer");
});

test("graphic lines are flagged, not hidden — editable, but the UI can warn", () => {
  const rows = documentLines(def(["{{barcode:cartonEan}}", "Plain"]), style(), undefined);
  assert.equal(rows[0].kind, "graphic");
  assert.equal(rows[0].resolved, "[barcode: cartonEan]");
  assert.equal(rows[1].kind, "text");
  // Wash symbols and the assortment table are graphics too.
  assert.equal(documentLines(def(["{{washSymbols}}"]), style(), undefined)[0].kind, "graphic");
  assert.equal(documentLines(def(["{{assortmentTable}}"]), style(), undefined)[0].kind, "graphic");
});

test("overriding a graphic line with text is allowed but reclassifies it", () => {
  const rows = documentLines(def(["{{barcode:cartonEan}}"]), style(), {
    [lineOverrideKey("p1", "b1", 0)]: "No barcode on this one",
  });
  assert.equal(rows[0].resolved, "No barcode on this one");
  // Still flagged graphic — the AUTHORED line draws one, so the warning stays
  // relevant ("you replaced a barcode with text").
  assert.equal(rows[0].kind, "graphic");
});

test("line addresses survive a round trip and reject junk", () => {
  assert.equal(isLineKey(lineOverrideKey("p1", "b1", 0)), true);
  assert.equal(isLineKey(lineOverrideKey("page-abc", "b-ms611tkj-3", 12)), true);
  assert.equal(isLineKey("colourName"), false); // a FIELD key, not a line
  assert.equal(isLineKey("p1|b1"), false);
  assert.equal(isLineKey("p1|b1|x"), false);
  assert.equal(isLineKey("|b1|0"), false);
  assert.equal(isLineKey(`${"p".repeat(41)}|b1|0`), false);
});

test("per-document overrides win over whole-output ones, line by line", () => {
  const k0 = lineOverrideKey("p1", "b1", 0);
  const k1 = lineOverrideKey("p1", "b1", 1);
  const merged = mergeLineValues({ [k0]: "base A", [k1]: "base B" }, { [k1]: "doc B" });
  assert.deepEqual(merged, { [k0]: "base A", [k1]: "doc B" });
  // Nothing on either side → undefined, so the renderer skips the lookup.
  assert.equal(mergeLineValues(undefined, undefined), undefined);
  assert.equal(mergeLineValues({}, undefined), undefined);
  // One-sided merges hand back the populated side untouched.
  assert.deepEqual(mergeLineValues({ [k0]: "x" }, undefined), { [k0]: "x" });
  assert.deepEqual(mergeLineValues(undefined, { [k0]: "y" }), { [k0]: "y" });
});

test("splitLineValues separates the whole-output key from per-document ones", () => {
  const k = lineOverrideKey("p1", "b1", 0);
  const all = new Map([
    ["layout:abc", { [k]: "all PDFs" }],
    ["layout:abc#S", { [k]: "just S" }],
    ["layout:abc#M", { [k]: "just M" }],
    ["layout:other", { [k]: "different output" }],
  ]);
  const { base, perDoc } = splitLineValues(all, "layout:abc");
  assert.deepEqual(base, { [k]: "all PDFs" });
  assert.equal(perDoc.size, 2);
  assert.deepEqual(perDoc.get("S"), { [k]: "just S" });
  assert.deepEqual(perDoc.get("M"), { [k]: "just M" });
  // A different output's key must not leak in.
  assert.equal(perDoc.has("other"), false);
});

test("conditionals still apply to an override, as they do to an authored line", () => {
  const s = { ...style(), multipleStyles: false } as StyleData;
  assert.equal(
    resolveLinePlain("{{if multipleStyles == true}}many{{else}}one{{endif}}", s),
    "one",
  );
});

test("a missing value resolves to nothing rather than leaking the token", () => {
  const s = { ...style(), batchNo: undefined } as StyleData;
  assert.equal(resolveLinePlain("Batch: {{batchNo}}", s), "Batch:");
});

// ---------------------------------------------------------------------------
// End-to-end through the real renderer. The whole point of this feature is that
// a saved edit reaches the PDF — the previous carton-qty bug was precisely an
// override that saved fine and then printed nothing. Assert on the HTML.
// ---------------------------------------------------------------------------

test("the override reaches the rendered HTML — hardcoded literal included", async () => {
  const { renderLayoutHtml } = await import("./render");
  const d = def();
  const s = style("Solid= 5/20");

  const before = await renderLayoutHtml(d, s, { mode: "production" });
  assert.match(before, /Inner box: 8 pair/);
  assert.match(before, /Outer box: 5 pair/);

  const after = await renderLayoutHtml(d, s, {
    mode: "production",
    lineOverrides: {
      [lineOverrideKey("p1", "b1", 0)]: "Inner box: 5 pair",
      [lineOverrideKey("p1", "b1", 1)]: "Outer box: {{qtyPerCarton:outer}} pair",
    },
  });
  assert.match(after, /Inner box: 5 pair/);
  assert.doesNotMatch(after, /Inner box: 8 pair/);
  // The token inside the override resolved — it is a source line, not literal.
  assert.match(after, /Outer box: 20 pair/);
  assert.doesNotMatch(after, /Outer box: 5 pair/);
});

test("no overrides → byte-identical render, so every existing output is untouched", async () => {
  const { renderLayoutHtml } = await import("./render");
  const d = def();
  const s = style("Solid= 5/20");
  const plain = await renderLayoutHtml(d, s, { mode: "production" });
  assert.equal(await renderLayoutHtml(d, s, { mode: "production", lineOverrides: {} }), plain);
  assert.equal(
    await renderLayoutHtml(d, s, { mode: "production", lineOverrides: undefined }),
    plain,
  );
  // An override addressing a line that isn't in THIS layout changes nothing.
  assert.equal(
    await renderLayoutHtml(d, s, {
      mode: "production",
      lineOverrides: { [lineOverrideKey("nope", "nope", 0)]: "should not appear" },
    }),
    plain,
  );
});

test("an override clears a line when set to blank text via the layout's own emptiness rule", async () => {
  const { renderLayoutHtml } = await import("./render");
  // A whitespace override renders as an empty line rather than the literal.
  const html = await renderLayoutHtml(def(), style("Solid= 5/20"), {
    mode: "production",
    lineOverrides: { [lineOverrideKey("p1", "b1", 0)]: " " },
  });
  assert.doesNotMatch(html, /Inner box: 8 pair/);
});
