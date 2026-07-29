import { test } from "node:test";
import assert from "node:assert/strict";
import { unambiguousCartonEan, formatCartonMap } from "./resolved-fields";

// ---------------------------------------------------------------------------
// Style.cartonEan is set only from an "Assort - <EAN>" line, so a style whose
// buyer typed per-size cartons has it NULL and every style-level surface reads
// "missing" while the cartons sit right there on the EAN rows.
//
// unambiguousCartonEan closes that gap for the ONE case where it's safe: all
// sizes sharing a single carton. It must NOT pick a value when they differ —
// that value would print on every carton label of a non-repeating layout.
// ---------------------------------------------------------------------------

test("all sizes share one carton → that value is the style's carton", () => {
  assert.equal(
    unambiguousCartonEan([
      { cartonEan: "7070001353354" },
      { cartonEan: "7070001353354" },
      { cartonEan: "7070001353354" },
    ]),
    "7070001353354",
  );
});

test("single size with a carton → that carton", () => {
  assert.equal(unambiguousCartonEan([{ cartonEan: "7070001353354" }]), "7070001353354");
});

test("sizes carry DIFFERENT cartons → null, never an arbitrary pick", () => {
  assert.equal(
    unambiguousCartonEan([
      { cartonEan: "5706323374662" },
      { cartonEan: "5706323374679" },
      { cartonEan: "5706323374686" },
    ]),
    null,
  );
});

test("blank / missing cartons are ignored, not treated as a second value", () => {
  assert.equal(
    unambiguousCartonEan([
      { cartonEan: "7070001353354" },
      { cartonEan: "   " },
      { cartonEan: null },
      { cartonEan: undefined },
    ]),
    "7070001353354",
  );
});

test("whitespace around an otherwise identical carton doesn't split it", () => {
  assert.equal(
    unambiguousCartonEan([{ cartonEan: " 7070001353354" }, { cartonEan: "7070001353354 " }]),
    "7070001353354",
  );
});

test("no cartons at all → null", () => {
  assert.equal(unambiguousCartonEan([{ cartonEan: null }, { cartonEan: "" }]), null);
  assert.equal(unambiguousCartonEan([]), null);
  assert.equal(unambiguousCartonEan(null), null);
  assert.equal(unambiguousCartonEan(undefined), null);
});

// --- display map -----------------------------------------------------------

test("formatCartonMap emits the same size=ean shape as the per-size EANs", () => {
  assert.equal(
    formatCartonMap([
      { size: "S", cartonEan: "5706323374662" },
      { size: "M", cartonEan: "5706323374679" },
    ]),
    "S=5706323374662,M=5706323374679",
  );
});

test("formatCartonMap skips rows with no carton or no size", () => {
  assert.equal(
    formatCartonMap([
      { size: "S", cartonEan: "5706323374662" },
      { size: "M", cartonEan: null },
      { size: "  ", cartonEan: "5706323374686" },
    ]),
    "S=5706323374662",
  );
  assert.equal(formatCartonMap([{ size: "S", cartonEan: null }]), "");
  assert.equal(formatCartonMap(null), "");
});
