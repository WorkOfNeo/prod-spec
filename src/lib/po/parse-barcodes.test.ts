import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBarcodeItems,
  selectStyleItems,
  cartonEanFor,
  variantsWithSectionCarton,
  type PoItem,
} from "./parse-barcodes";

// The flattened text of the Barcodes page of a real multi-style Contrast PO
// (C-PO63315) — nine styles, each section opening with "<No.> <style number> -
// <name>". Captured verbatim from pdf-parse so the parser is tested against the
// real layout without committing the customer PDF.
const MULTI_STYLE_PAGE = [
  "No. Variant Description Barcode EAN Polybag EAN Carton SU per",
  "Polybag/Cart",
  "on",
  "C-33418 PTQ60032 - Pyjamas",
  "ASS1 PTQ60032 - Pyjamas 5706323598945 5706323598945 14/14",
  "PI-86/92 Pink, 86/92 5706323598907",
  "PI-98/104 Pink, 98/104 5706323598907",
  "PI-110/116 Pink, 110/116 5706323598907",
  "PI-122/128 Pink, 122/128 5706323598907",
  "C-33419 PTQ20029 - Sweat shirt",
  "ASS1 PTQ20029 - Sweat shirt 5706323598990 5706323598990 12/12",
  "PI-86/92 Pink, 86/92 5706323598952",
  "PI-98/104 Pink, 98/104 5706323598952",
  "PI-110/116 Pink, 110/116 5706323598952",
  "PI-122/128 Pink, 122/128 5706323598952",
  "C-33420 PTQ30031 - Dress",
  "ASS1 PTQ30031 - Dress 5706323599034 5706323599034 12/12",
  "PI-86/92 Pink, 86/92 5706323599003",
  "PI-98/104 Pink, 98/104 5706323599003",
  "PI-110/116 Pink, 110/116 5706323599003",
  "C-33421 PTQ70037 - Sweat Set",
  "ASS1 PTQ70037 - Sweat Set 5706323599089 5706323599089 12/12",
  "GR-86/92 Green, 86/92 5706323599041",
  "GR-98/104 Green, 98/104 5706323599041",
  "GR-110/116 Green, 110/116 5706323599041",
  "GR-122/128 Green, 122/128 5706323599041",
  "C-33422 PTQ10045 - T shirt",
  "ASS1 PTQ10045 - T shirt 5706323599133 5706323599133 14/14",
  "PI-86/92 Pink, 86/92 5706323599096",
  "PI-98/104 Pink, 98/104 5706323599096",
  "PI-110/116 Pink, 110/116 5706323599096",
  "PI-122/128 Pink, 122/128 5706323599096",
  "C-33423 PTQ60031 - Pyjamas",
  "ASS1 PTQ60031 - Pyjamas 5706323599188 5706323599188 14/14",
  ".B-86/92 Blue, 86/92 5706323599140",
  ".B-98/104 Blue, 98/104 5706323599140",
  ".B-110/116 Blue, 110/116 5706323599140",
  ".B-122/128 Blue, 122/128 5706323599140",
  "C-33424 PTQ70036 - Sweat set",
  "ASS1 PTQ70036 - Sweat set 5706323599232 5706323599232 12/12",
  "NA-86/92 Navy, 86/92 5706323599195",
  "NA-98/104 Navy, 98/104 5706323599195",
  "NA-110/116 Navy, 110/116 5706323599195",
  "NA-122/128 Navy, 122/128 5706323599195",
  "C-33425 PTQ20027 - Sweat shirt",
  "ASS1 PTQ20027 - Sweat shirt 5706323599287 5706323599287 12/12",
  "NA-86/92 Navy, 86/92 5706323599249",
  "NA-98/104 Navy, 98/104 5706323599249",
  "NA-110/116 Navy, 110/116 5706323599249",
  "NA-122/128 Navy, 122/128 5706323599249",
  "C-33426 PTQ10046 - T shirt",
  "ASS1 PTQ10046 - T shirt 5706323599331 5706323599331 14/14",
  ".B-86/92 Blue, 86/92 5706323599294",
  ".B-98/104 Blue, 98/104 5706323599294",
  ".B-110/116 Blue, 110/116 5706323599294",
  ".B-122/128 Blue, 122/128 5706323599294",
  "Page 1\tPurchase Order C-PO63315 - Barcodes",
].join("\n");

test("parseBarcodeItems — splits a multi-style PO into one item per style", () => {
  const items = parseBarcodeItems(MULTI_STYLE_PAGE);
  assert.equal(items.length, 9);
  assert.deepEqual(
    items.map((i) => i.styleNumber),
    [
      "PTQ60032",
      "PTQ20029",
      "PTQ30031",
      "PTQ70037",
      "PTQ10045",
      "PTQ60031",
      "PTQ70036",
      "PTQ20027",
      "PTQ10046",
    ],
  );
  // The PO carries no Customer Item No (Contrast identifies by style number).
  assert.ok(items.every((i) => i.customerItemNo === null));
});

test("parseBarcodeItems — captures the right variants + carton EAN per section", () => {
  const items = parseBarcodeItems(MULTI_STYLE_PAGE);
  const ptq60031 = items.find((i) => i.styleNumber === "PTQ60031");
  assert.ok(ptq60031);
  assert.equal(ptq60031.contrastNo, "C-33423");
  assert.equal(ptq60031.variants.length, 4);
  // Every size variant of this style carries the same per-unit Barcode EAN…
  assert.ok(ptq60031.variants.every((v) => v.ean13 === "5706323599140"));
  // …and only this style's variants — no Pink/Green/Navy bleed-through.
  assert.deepEqual(
    ptq60031.variants.map((v) => v.label),
    [
      ".B-86/92 Blue, 86/92",
      ".B-98/104 Blue, 98/104",
      ".B-110/116 Blue, 110/116",
      ".B-122/128 Blue, 122/128",
    ],
  );
  // The ASS row's carton EAN is captured as the assortment EAN.
  assert.equal(ptq60031.assortmentEans[0], "5706323599188");
});

test("selectStyleItems — style-number match picks only that section", () => {
  const items = parseBarcodeItems(MULTI_STYLE_PAGE);
  const sel = selectStyleItems(items, { styleNumber: "PTQ60031" });
  assert.equal(sel.kind, "styleNumber");
  assert.equal(sel.items.length, 1);
  assert.equal(sel.items[0].styleNumber, "PTQ60031");
  // The fix in one assertion: every selected EAN belongs to PTQ60031, so the
  // shared size run (86/92…) no longer pulls in eight other styles' barcodes.
  const eans = new Set(sel.items.flatMap((i) => i.variants).map((v) => v.ean13));
  assert.deepEqual([...eans], ["5706323599140"]);
  assert.equal(sel.poStyleNumbers.length, 9);
});

test("selectStyleItems — style number is matched case/punctuation-insensitively", () => {
  const items = parseBarcodeItems(MULTI_STYLE_PAGE);
  const sel = selectStyleItems(items, { styleNumber: "ptq-60031" });
  assert.equal(sel.kind, "styleNumber");
  assert.equal(sel.items[0].styleNumber, "PTQ60031");
});

test("selectStyleItems — rejects when no section matches the style number", () => {
  const items = parseBarcodeItems(MULTI_STYLE_PAGE);
  const sel = selectStyleItems(items, { styleNumber: "PTQ99999" });
  assert.equal(sel.kind, "reject");
  assert.equal(sel.items.length, 0);
  // The candidate set is surfaced for the operator-facing reject message.
  assert.ok(sel.poStyleNumbers.includes("PTQ60031"));
});

test("selectStyleItems — Customer Item No wins over style number when present", () => {
  const items: PoItem[] = [
    { contrastNo: "C-1", customerItemNo: "316-246-1024", styleNumber: "AAA111", variants: [], assortmentEans: [] },
    { contrastNo: "C-2", customerItemNo: "316-246-2048", styleNumber: "BBB222", variants: [], assortmentEans: [] },
  ];
  const sel = selectStyleItems(items, { customerItemNo: "316-246-2048", styleNumber: "AAA111" });
  assert.equal(sel.kind, "customerItemNo");
  assert.equal(sel.items[0].contrastNo, "C-2");
});

test("selectStyleItems — falls back to all items when the PO has no style headers", () => {
  // A legacy/different layout where the parser found no style-number headers:
  // keep the old behaviour and aggregate every item (single-style PO + wrapper).
  const items: PoItem[] = [
    { contrastNo: "C-1", customerItemNo: null, styleNumber: null, variants: [{ label: "M", ean13: "1111111111111", unitsPer: null }], assortmentEans: [] },
    { contrastNo: "C-2", customerItemNo: null, styleNumber: null, variants: [{ label: "L", ean13: "2222222222222", unitsPer: null }], assortmentEans: [] },
  ];
  const sel = selectStyleItems(items, { styleNumber: "WHATEVER" });
  assert.equal(sel.kind, "all");
  assert.equal(sel.items.length, 2);
});

const item = (over: Partial<PoItem>): PoItem => ({
  contrastNo: null,
  customerItemNo: null,
  styleNumber: null,
  variants: [],
  assortmentEans: [],
  ...over,
});

test("cartonEanFor — uses the matched section's own assortment EAN", () => {
  const a = item({ styleNumber: "AAA", assortmentEans: ["1111111111111"] });
  const b = item({ styleNumber: "BBB", assortmentEans: ["2222222222222"] });
  assert.equal(cartonEanFor([a], [a, b]), "1111111111111");
});

test("cartonEanFor — falls back to a pack/assortment carton when the section has none", () => {
  // A 2-pack PO: the pack line carries the carton; each style carries only its
  // unit EAN. Per-style selection must still surface the pack carton.
  const pack = item({ contrastNo: "C-33434", styleNumber: null, assortmentEans: ["9999999999999"] });
  const style = item({
    styleNumber: "IL97336",
    variants: [{ label: "One Size", ean13: "1111111111111", unitsPer: null }],
  });
  assert.equal(cartonEanFor([style], [pack, style]), "9999999999999");
});

test("cartonEanFor — null when no carton exists anywhere in the PO", () => {
  const style = item({ styleNumber: "AC90004", variants: [{ label: "One Size", ean13: "1", unitsPer: null }] });
  assert.equal(cartonEanFor([style], [style]), null);
});

test("parseBarcodeItems — a bare pack/assortment line is not mistaken for a style", () => {
  // The "No." header of an assortment line leads with a Contrast article no
  // (C-33434), which must not be captured as a style number.
  const raw = [
    "No. Variant Description Barcode EAN Polybag EAN Carton SU per",
    "C-33434 C-33434 Pack",
    "ASS1 5706323599812 5706323599812 14/14",
    "C-33432 IL97336 - Socks",
    "One Size IL97336 Socks 5706323599799",
  ].join("\n");
  const items = parseBarcodeItems(raw);
  const pack = items.find((i) => i.contrastNo === "C-33434");
  assert.ok(pack);
  assert.equal(pack.styleNumber, null);
  assert.equal(items.find((i) => i.contrastNo === "C-33432")?.styleNumber, "IL97336");
});

test("selectStyleItems — matches across a market suffix on the style name", () => {
  // Multi-style PO; Style.name carries a "- DE" market suffix the PO omits.
  const items: PoItem[] = [
    item({ contrastNo: "C-1", styleNumber: "KH20114", variants: [{ label: "M", ean13: "1111111111111", unitsPer: null }] }),
    item({ contrastNo: "C-2", styleNumber: "KH20115", variants: [{ label: "M", ean13: "2222222222222", unitsPer: null }] }),
  ];
  const sel = selectStyleItems(items, { styleNumber: "KH20114 - DE" });
  assert.equal(sel.kind, "styleNumber");
  assert.equal(sel.items.length, 1);
  assert.equal(sel.items[0].styleNumber, "KH20114"); // disambiguated, not KH20115
});

test("selectStyleItems — single-section PO is taken even when the style number differs", () => {
  // A multi-pack "KH90051 E+…" is listed under its own assortment code. One
  // section ⇒ unambiguous ⇒ take it rather than reject (no other style to
  // confuse it with).
  const items: PoItem[] = [
    item({ contrastNo: "C-9", styleNumber: null, assortmentEans: ["9999999999999"] }),
    item({ contrastNo: "C-1", styleNumber: "KHC00193", variants: [{ label: "39/42", ean13: "1111111111111", unitsPer: null }] }),
  ];
  const sel = selectStyleItems(items, { styleNumber: "KH90051 E+KH90051 E -CZ" });
  assert.equal(sel.kind, "all");
  assert.equal(sel.items.length, 2);
});

test("selectStyleItems — matches across a no-space market suffix (straggler)", () => {
  const items: PoItem[] = [
    item({ contrastNo: "C-1", styleNumber: "KH10072", variants: [{ label: "M", ean13: "1111111111111", unitsPer: null }] }),
    item({ contrastNo: "C-2", styleNumber: "KH10155", variants: [{ label: "M", ean13: "2222222222222", unitsPer: null }] }),
  ];
  const sel = selectStyleItems(items, { styleNumber: "KH10155- CZ" }); // no space before "-"
  assert.equal(sel.kind, "styleNumber");
  assert.equal(sel.items[0].styleNumber, "KH10155");
});

test("selectStyleItems — does NOT reject a descriptive/bundle style on a multi-section PO", () => {
  // Bundle ("X+Y") and JYSK descriptive names can't be matched by style number
  // (the PO uses assortment codes / unrelated sections) — they must keep the
  // take-all fallback rather than reject, so we never regress them.
  const po: PoItem[] = [
    item({ contrastNo: "C-1", styleNumber: "ILC01929", variants: [{ label: "M", ean13: "1111111111111", unitsPer: null }] }),
    item({ contrastNo: "C-2", styleNumber: "ILC01930", variants: [{ label: "M", ean13: "2222222222222", unitsPer: null }] }),
  ];
  assert.equal(selectStyleItems(po, { styleNumber: "IL43992A+IL43989A" }).kind, "all");
  assert.equal(selectStyleItems(po, { styleNumber: "JYSK [Espen small]" }).kind, "all");
});

test("selectStyleItems — still rejects a clean single style number absent from a multi-style PO", () => {
  const po: PoItem[] = [
    item({ contrastNo: "C-1", styleNumber: "PTQ60031", variants: [{ label: "M", ean13: "1", unitsPer: null }] }),
    item({ contrastNo: "C-2", styleNumber: "PTQ60032", variants: [{ label: "M", ean13: "2", unitsPer: null }] }),
  ];
  assert.equal(selectStyleItems(po, { styleNumber: "PTQ99999" }).kind, "reject");
});

test("variantsWithSectionCarton — each colourway keeps its own section's carton", () => {
  // A multi-colourway style is listed as one section per colour, each with its
  // own carton EAN. The Blue rows must carry the Blue carton and the Pink rows
  // the Pink carton — not both collapsed to the first section's carton.
  const raw = [
    "No. Variant Description Barcode EAN Polybag EAN Carton SU per",
    "C-40001 PTQ77777 - Hoodie",
    "ASS1 PTQ77777 - Hoodie 1111111111116 1111111111116 6/6",
    ".B-S Blue, S 2222222222223",
    ".B-M Blue, M 2222222222223",
    "C-40002 PTQ77777 - Hoodie",
    "ASS1 PTQ77777 - Hoodie 3333333333334 3333333333334 6/6",
    "PI-S Pink, S 4444444444445",
    "PI-M Pink, M 4444444444445",
  ].join("\n");

  const sel = selectStyleItems(parseBarcodeItems(raw), { styleNumber: "PTQ77777" });
  assert.equal(sel.kind, "styleNumber");
  assert.equal(sel.items.length, 2); // both colour sections

  const tagged = variantsWithSectionCarton(sel.items);
  const blue = tagged.filter((v) => v.label.includes("Blue"));
  const pink = tagged.filter((v) => v.label.includes("Pink"));
  assert.ok(blue.length === 2 && blue.every((v) => v.cartonEan === "1111111111116"));
  assert.ok(pink.length === 2 && pink.every((v) => v.cartonEan === "3333333333334"));
});
