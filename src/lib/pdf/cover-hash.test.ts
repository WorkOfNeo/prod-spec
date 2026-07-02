import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverHash, type CoverHashInput } from "./cover-hash";

const base: CoverHashInput = {
  customerName: "COOP",
  businessArea: "Ladies Knitwear",
  styleName: "17742",
  styleNumber: "17742",
  poNumber: "C-PO63180",
  supplierName: "Textile Expo",
  docs: [
    { displayName: "Care label", widthMm: 40, heightMm: 60, fileCount: 3 },
    { displayName: "Carton marking", widthMm: 100, heightMm: 100, fileCount: 1 },
  ],
  coverSettings: { marginMm: 10, fontPt: 9 },
  generalInfo: { markdown: "Wash cold.", settings: { marginMm: 12 } },
};

test("computeCoverHash — identical inputs hash identically", () => {
  assert.equal(computeCoverHash(base), computeCoverHash({ ...base }));
});

test("computeCoverHash — doc ORDER does not change the hash", () => {
  const reordered = { ...base, docs: [base.docs[1], base.docs[0]] };
  assert.equal(computeCoverHash(base), computeCoverHash(reordered));
});

test("computeCoverHash — cover settings key order does not change the hash", () => {
  const reorderedSettings = { ...base, coverSettings: { fontPt: 9, marginMm: 10 } };
  assert.equal(computeCoverHash(base), computeCoverHash(reorderedSettings));
});

test("computeCoverHash — changing general-info markdown changes the hash", () => {
  const changed = { ...base, generalInfo: { markdown: "Wash warm.", settings: { marginMm: 12 } } };
  assert.notEqual(computeCoverHash(base), computeCoverHash(changed));
});

test("computeCoverHash — adding a document changes the hash", () => {
  const added = {
    ...base,
    docs: [...base.docs, { displayName: "Sticker", widthMm: 50, heightMm: 50, fileCount: 1 }],
  };
  assert.notEqual(computeCoverHash(base), computeCoverHash(added));
});

test("computeCoverHash — changing a doc's file count changes the hash", () => {
  const changed = {
    ...base,
    docs: [{ ...base.docs[0], fileCount: 4 }, base.docs[1]],
  };
  assert.notEqual(computeCoverHash(base), computeCoverHash(changed));
});

test("computeCoverHash — dropping general info changes the hash", () => {
  const noGi = { ...base, generalInfo: null };
  assert.notEqual(computeCoverHash(base), computeCoverHash(noGi));
});

test("computeCoverHash — changing PO / identity changes the hash", () => {
  assert.notEqual(computeCoverHash(base), computeCoverHash({ ...base, poNumber: "C-PO63181" }));
});
