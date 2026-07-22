import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileEans, eanRowKey, type EanRow } from "./ean-overrides";

const scrapeRow = (size: string, ean13: string | null, cartonEan: string | null = null) => ({
  size,
  ean13,
  variantLabel: `${size} label`,
  cartonEan,
});
const row = (over: Partial<EanRow> & { size: string; ean13: string | null }): EanRow => ({
  variantLabel: null,
  cartonEan: null,
  excluded: false,
  manual: false,
  ...over,
});

test("eanRowKey — normalises size, ignores position", () => {
  assert.equal(eanRowKey("M", "5706323604349"), eanRowKey(" m ", "5706323604349"));
  assert.notEqual(eanRowKey("M", "111"), eanRowKey("M", "222"));
});

test("reconcileEans — a fresh scrape with no prior overrides is passed through", () => {
  const out = reconcileEans([], [scrapeRow("S", "111"), scrapeRow("M", "222")]);
  assert.deepEqual(
    out.map((r) => [r.size, r.ean13, r.excluded, r.manual]),
    [
      ["S", "111", false, false],
      ["M", "222", false, false],
    ],
  );
});

test("reconcileEans — an excluded row stays excluded across re-resolve (size+ean match)", () => {
  const prev = [row({ size: "S", ean13: "111", excluded: true }), row({ size: "M", ean13: "222" })];
  const out = reconcileEans(prev, [scrapeRow("S", "111"), scrapeRow("M", "222")]);
  assert.equal(out.find((r) => r.ean13 === "111")!.excluded, true);
  assert.equal(out.find((r) => r.ean13 === "222")!.excluded, false);
});

test("reconcileEans — exclusion is dropped when that EAN is gone from the new scrape", () => {
  const prev = [row({ size: "S", ean13: "111", excluded: true })];
  // New scrape no longer has 111 → nothing to carry the flag onto.
  const out = reconcileEans(prev, [scrapeRow("S", "999")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ean13, "999");
  assert.equal(out[0].excluded, false);
});

test("reconcileEans — a manual row survives a re-resolve that doesn't include it", () => {
  const prev = [row({ size: "S", ean13: "111" }), row({ size: "XL", ean13: "555", manual: true })];
  const out = reconcileEans(prev, [scrapeRow("S", "111")]);
  assert.equal(out.length, 2);
  const manual = out.find((r) => r.ean13 === "555")!;
  assert.equal(manual.manual, true);
  assert.equal(manual.size, "XL");
});

test("reconcileEans — a manual row the scrape now yields itself is de-duped to the scrape row", () => {
  const prev = [row({ size: "XL", ean13: "555", manual: true })];
  const out = reconcileEans(prev, [scrapeRow("XL", "555")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].manual, false); // now a real scrape row, not manual
});

test("reconcileEans — a manual row can itself be excluded and stays so", () => {
  const prev = [row({ size: "XL", ean13: "555", manual: true, excluded: true })];
  const out = reconcileEans(prev, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].manual, true);
  assert.equal(out[0].excluded, true);
});
