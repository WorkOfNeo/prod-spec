import { test } from "node:test";
import assert from "node:assert/strict";

import { cartonGroupFileName } from "./file-name";

test("cartonGroupFileName — PO, main style first, comma separated", () => {
  assert.equal(
    cartonGroupFileName({
      poNumber: "4468",
      mainStyleNumber: "29904",
      otherStyleNumbers: ["29907"],
    }),
    "4468-29904,29907-Carton-Marking.pdf",
  );
});

test("cartonGroupFileName — main style leads even when picked last", () => {
  assert.equal(
    cartonGroupFileName({
      poNumber: "4471",
      mainStyleNumber: "30130",
      otherStyleNumbers: ["30112", "30118"],
    }),
    "4471-30130,30112,30118-Carton-Marking.pdf",
  );
});

test("cartonGroupFileName — a style picked twice is listed once", () => {
  assert.equal(
    cartonGroupFileName({
      poNumber: "4471",
      mainStyleNumber: "30112",
      otherStyleNumbers: ["30112", "30118"],
    }),
    "4471-30112,30118-Carton-Marking.pdf",
  );
});

test("cartonGroupFileName — blank style numbers never produce empty slots", () => {
  assert.equal(
    cartonGroupFileName({
      poNumber: "4471",
      mainStyleNumber: "30112",
      otherStyleNumbers: ["", "  ", "30118"],
    }),
    "4471-30112,30118-Carton-Marking.pdf",
  );
});

test("cartonGroupFileName — a style with no PO still gets a usable name", () => {
  assert.equal(
    cartonGroupFileName({
      poNumber: null,
      mainStyleNumber: "30112",
      otherStyleNumbers: ["30118"],
    }),
    "30112,30118-Carton-Marking.pdf",
  );
});

test("cartonGroupFileName — path-hostile characters are stripped", () => {
  // Style numbers come off Monday free-text columns; a stray slash must not
  // turn the filename into a folder path at upload time.
  assert.equal(
    cartonGroupFileName({
      poNumber: "44/71",
      mainStyleNumber: "301 12",
      otherStyleNumbers: ["30118*"],
    }),
    "4471-301-12,30118-Carton-Marking.pdf",
  );
});
