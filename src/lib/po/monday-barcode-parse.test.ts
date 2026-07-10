import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEan13, parseBarcodeField, eanForSize } from "./monday-barcode-parse";

// Real EAN-13s pulled from the Pre-Order barcode columns (all valid check digit).
const S = "7070001349678";
const M = "7070001349661";
const L = "7070001349654";
const ASSORT = "7070001870127";

test("isValidEan13 — accepts real 13-digit EANs, rejects short/bad ones", () => {
  assert.ok(isValidEan13(S));
  assert.ok(isValidEan13(ASSORT));
  assert.ok(isValidEan13("6438574710423"));
  assert.equal(isValidEan13("030303030303"), false); // 12 digits — the placeholder
  assert.equal(isValidEan13("7070001349679"), false); // valid length, wrong check digit
  assert.equal(isValidEan13(""), false);
});

test("parseBarcodeField — colour prefix + SIZE:EAN pairs (IL22414 product field)", () => {
  const p = parseBarcodeField(`Solid - S:${S}, M: ${M}, L: ${L}.`);
  assert.deepEqual(p.bySize, [
    { sizeKey: "S", ean: S },
    { sizeKey: "M", ean: M },
    { sizeKey: "L", ean: L },
  ]);
  assert.equal(p.assort, null);
  assert.deepEqual(p.invalid, []);
});

test("parseBarcodeField — carton field carries an Assort line", () => {
  const p = parseBarcodeField(`Solid - S:${S}, M: ${M}.\nAssort - ${ASSORT}`);
  assert.equal(p.assort, ASSORT);
  assert.equal(p.bySize.length, 2);
});

test("parseBarcodeField — labelled pairs with slashed sizes, no colour (IL84138)", () => {
  const p = parseBarcodeField("M/L: 7070001349999, XL/XXL: 7070001350001, 3XL: 7070001349982");
  assert.deepEqual(
    p.bySize.map((x) => x.sizeKey),
    ["M/L", "XL/XXL", "3XL"],
  );
  assert.equal(p.bareEans.length, 0);
});

test("parseBarcodeField — bare unlabelled list stays in bareEans (NOT positionally mapped)", () => {
  // Per the product decision, an unlabelled multi-EAN list is not zipped to sizes.
  const p = parseBarcodeField("6438574710423, 6438574710614, 6438574710805, 6438574709939");
  assert.equal(p.bySize.length, 0);
  assert.equal(p.bareEans.length, 4);
});

test("parseBarcodeField — single bare EAN (IL97337)", () => {
  const p = parseBarcodeField("7070001353354");
  assert.deepEqual(p.bareEans, ["7070001353354"]);
  assert.equal(p.bySize.length, 0);
});

test("parseBarcodeField — invalid tokens are dropped into `invalid`, never bySize", () => {
  const p = parseBarcodeField(`S:${S}, M: 030303030303, L: notanumber`);
  assert.deepEqual(p.bySize, [{ sizeKey: "S", ean: S }]);
  assert.equal(p.invalid.length, 2);
});

test("eanForSize — keyed lookup; unlisted sizes get null (XS absent in IL22414)", () => {
  const p = parseBarcodeField(`Solid - S:${S}, M: ${M}, L: ${L}`);
  assert.equal(eanForSize("S", p.bySize), S);
  assert.equal(eanForSize("M", p.bySize), M);
  assert.equal(eanForSize("XS", p.bySize), null); // not listed → stays empty
  assert.equal(eanForSize("XL", p.bySize), null);
});

test("eanForSize — 'S' does not bleed onto 'XS'/'M/L'", () => {
  const p = parseBarcodeField(`S:${S}`);
  assert.equal(eanForSize("XS", p.bySize), null);
  assert.equal(eanForSize("M/L", p.bySize), null);
});
