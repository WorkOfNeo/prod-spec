// Proof the OTTO'S AG carton marking — the colour × size assortment matrix —
// against a REAL style, without writing anything to the DB.
//
//   tsx --env-file=.env scripts/proof-ottos-carton.ts <styleId> [out.pdf]
//
// The layout is built here rather than saved so the shape can be iterated on
// before anyone commits it to a DB row; the def it prints is the exact JSON
// the Output Builder would store.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import { renderPdf } from "@/lib/pdf/renderer";
import { loadStyleRenderContext } from "@/lib/styles/render-context";

// ---------------------------------------------------------------------
// Geometry. 210 × 82 mm landscape, a 48 × 39 grid so every rule on the
// customer's form lands on a grid line.
// ---------------------------------------------------------------------
const COLS = 48;
const ROWS = 39;

const COLOUR_COL = { col: 0, span: 10 };
const SIZE_COLS = Array.from({ length: 7 }, (_, i) => ({ col: 10 + i * 4, span: 4 }));
const TOTAL_COL = { col: 38, span: 10 };

const R = {
  title: { row: 0, span: 6 },
  channel: { row: 6, span: 3 },
  supplier: { row: 9, span: 2 },
  orderNo: { row: 11, span: 2 },
  lotNo: { row: 13, span: 2 },
  articleNo: { row: 15, span: 2 },
  matrixHead: { row: 17, span: 4 },
  firstColour: 21,
  colourSpan: 2,
  colourRows: 8,
  footer: { row: 37, span: 2 },
};

// Every cell draws only its TOP and LEFT rule; the page frame closes the
// right and bottom edges. That is what keeps the grid single-weight —
// bordering all four sides doubles every interior line.
const CELL = { widthMm: 0.3, color: "#000000", sides: { top: true, right: false, bottom: false, left: true } };
const PAD = { topMm: 0.4, rightMm: 0.6, bottomMm: 0.4, leftMm: 0.6 };

type Cell = {
  col: number;
  span: number;
  row: number;
  rowSpan: number;
  lines: string[];
  fontPt?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  border?: boolean;
};

let seq = 0;
function block(c: Cell) {
  return {
    id: `b${++seq}`,
    rect: { col: c.col, row: c.row, colSpan: c.span, rowSpan: c.rowSpan },
    fontPt: c.fontPt ?? 7,
    bold: c.bold ?? true,
    align: c.align ?? "center",
    valign: c.valign ?? "middle",
    lineHeight: 1.15,
    ...(c.border === false ? {} : { border: { ...CELL, pad: PAD } }),
    lines: c.lines,
  };
}

const cells: ReturnType<typeof block>[] = [];
const add = (c: Cell) => cells.push(block(c));

// ---- Title + carton number ------------------------------------------
add({ ...R.title, rowSpan: R.title.span, col: 0, span: 38, lines: ["OTTO`S AG"], fontPt: 26 });
add({ col: 38, span: 10, row: 0, rowSpan: 3, lines: ["Carton No."], fontPt: 7 });
add({ col: 38, span: 10, row: 3, rowSpan: 3, lines: [""] });

// ---- Channel row -----------------------------------------------------
// The ticked box is the customer's own channel mark, not style data.
add({ col: 0, span: 12, row: R.channel.row, rowSpan: R.channel.span, lines: ["☒ Otto`s"], fontPt: 8, align: "left" });
add({ col: 12, span: 16, row: R.channel.row, rowSpan: R.channel.span, lines: ["☐ Radikal"], fontPt: 8, align: "left" });
add({ col: 28, span: 20, row: R.channel.row, rowSpan: R.channel.span, lines: ["☐ Webshop"], fontPt: 8, align: "left" });

// ---- Order detail rows ----------------------------------------------
const detail = (r: { row: number; span: number }, label: string, value: string) => {
  add({ col: 0, span: 8, row: r.row, rowSpan: r.span, lines: [label], fontPt: 7, align: "left" });
  add({ col: 8, span: 40, row: r.row, rowSpan: r.span, lines: [value], fontPt: 7 });
};
detail(R.supplier, "Supplier", "Contrast Company");
detail(R.orderNo, "Order No.", "{{customerOrderNo}}");
detail(R.lotNo, "Lot No.", "{{lot}}");
detail(R.articleNo, "Article No.", "{{customerItemNo}}");

// ---- Matrix header ---------------------------------------------------
// The diagonal Size/Color corner is pure decoration — two lines here; drop
// in {{image:ottos-size-colour-corner}} once the artwork is in the library.
add({
  ...R.matrixHead,
  rowSpan: R.matrixHead.span,
  ...COLOUR_COL,
  lines: ["                    Size", "Color"],
  fontPt: 7,
  align: "left",
});
SIZE_COLS.forEach((c, i) => {
  add({ ...c, row: R.matrixHead.row, rowSpan: R.matrixHead.span, lines: [`{{sizeAt:${i + 1}}}`], fontPt: 9 });
});
add({ ...TOTAL_COL, row: R.matrixHead.row, rowSpan: R.matrixHead.span, lines: ["Total PCS"], fontPt: 7 });

// ---- Colour rows -----------------------------------------------------
// Row 1 is the base style; rows 2–8 are the sibling slots, which stay blank
// on a single-style print and fill on a multi-style carton.
for (let k = 0; k < R.colourRows; k++) {
  const row = R.firstColour + k * R.colourSpan;
  const prefix = k === 0 ? "" : `style${k + 1}`;
  const colour = k === 0 ? "{{colourName}}" : `{{${prefix}ColourName}}`;
  const qty = (n: number) => (k === 0 ? `{{sizeQty:${n}}}` : `{{${prefix}SizeQty:${n}}}`);
  const total = k === 0 ? "{{sizeQtyTotal}}" : `{{${prefix}SizeQtyTotal}}`;

  add({ ...COLOUR_COL, row, rowSpan: R.colourSpan, lines: [colour], fontPt: 8 });
  SIZE_COLS.forEach((c, i) => add({ ...c, row, rowSpan: R.colourSpan, lines: [qty(i + 1)], fontPt: 8 }));
  add({ ...TOTAL_COL, row, rowSpan: R.colourSpan, lines: [total], fontPt: 8 });
}

// ---- Footer ----------------------------------------------------------
add({ col: 0, span: 10, row: R.footer.row, rowSpan: R.footer.span, lines: ["Total PCS per Lot"], fontPt: 7, align: "left" });
add({ col: 10, span: 8, row: R.footer.row, rowSpan: R.footer.span, lines: [""] });
add({ col: 18, span: 10, row: R.footer.row, rowSpan: R.footer.span, lines: ["LOT QUANTITY"], fontPt: 7, align: "left" });
add({ col: 28, span: 4, row: R.footer.row, rowSpan: R.footer.span, lines: [""] });
add({ col: 32, span: 6, row: R.footer.row, rowSpan: R.footer.span, lines: ["TOTAL PCS"], fontPt: 7, align: "left" });
add({ ...TOTAL_COL, row: R.footer.row, rowSpan: R.footer.span, lines: ["{{= sum(sizeQtyTotal) }}"], fontPt: 8 });

const definition: LayoutDef = parseLayoutDef({
  pages: [
    {
      id: "p1",
      title: "Carton marking",
      widthMm: 210,
      heightMm: 82,
      margins: { topMm: 3, rightMm: 3, bottomMm: 3, leftMm: 3 },
      gridCols: COLS,
      gridRows: ROWS,
      // Closes the right and bottom of every cell, so the grid reads as one
      // ruled table instead of doubled interior lines.
      pageBorder: { widthMm: 0.3, color: "#000000", insetMm: 3 },
      blocks: cells,
    },
  ],
  settings: { multipleStyles: true, fileName: "{{customerOrderNo}}-Carton Marking" },
});

async function main() {
  const styleId = process.argv[2];
  const out = process.argv[3] ?? "/tmp/layout-proofs/ottos-carton.pdf";
  if (!styleId) throw new Error("usage: proof-ottos-carton.ts <styleId> [out.pdf]");

  const ctx = await loadStyleRenderContext(styleId);
  if (!ctx) throw new Error(`no render context for style ${styleId}`);
  // A multi-style carton: the operator's sibling picks are what fill rows
  // 2–8. Here we take the whole same-PO pool so the matrix is exercised.
  const style = { ...ctx.styleData, multipleStyles: true };

  const html = await renderLayoutHtml(definition, style, {
    mode: "production",
    title: "OTTO`S AG - Carton Marking",
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await renderPdf({ html }));
  console.log(`wrote ${out}`);
  console.log(`blocks: ${cells.length}, siblings: ${style.siblings?.length ?? 0}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
