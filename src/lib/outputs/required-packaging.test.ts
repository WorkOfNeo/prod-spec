import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleRequiredPackagingDocs,
  type RequiredPackagingRow,
} from "./required-packaging";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { DEFAULT_TRIM_RULES } from "@/lib/trims/classify";
import { manifestFingerprint } from "@/lib/trims/manifest";

const row = (variantKey: string, widthMm: number, heightMm: number): RequiredPackagingRow => ({
  variantKey,
  displayName: variantKey,
  widthMm,
  heightMm,
  fileCount: 1,
});

test("assembleRequiredPackagingDocs — flags approved vs pending by base key", () => {
  const docs = assembleRequiredPackagingDocs(
    [row("care-label-01", 40, 30), row("layout:carton", 210, 148)],
    new Set(["care-label-01"]),
  );
  assert.deepEqual(
    docs.map((d) => ({ name: d.displayName, w: d.widthMm, h: d.heightMm, approved: d.approved })),
    [
      { name: "care-label-01", w: 40, h: 30, approved: true },
      { name: "layout:carton", w: 210, h: 148, approved: false },
    ],
  );
});

test("assembleRequiredPackagingDocs — never lists the bundle framing pages", () => {
  const docs = assembleRequiredPackagingDocs(
    [
      row(COVER_VARIANT_KEY, 210, 297),
      row(GENERAL_INFO_VARIANT_KEY, 210, 297),
      row("care-label-02", 55, 25),
    ],
    new Set(),
  );
  assert.deepEqual(
    docs.map((d) => d.displayName),
    ["care-label-02"],
  );
});

test("assembleRequiredPackagingDocs — approval is keyed by BASE, ignoring a #suffix", () => {
  // A declared output carries the base key; the approved set is base keys too.
  // Guard the split() so a future suffixed declared key still matches.
  const docs = assembleRequiredPackagingDocs(
    [row("layout:hangtag#front", 90, 50)],
    new Set(["layout:hangtag"]),
  );
  assert.equal(docs[0].approved, true);
});

test("assembleRequiredPackagingDocs — all-approved set produces no pending rows", () => {
  const docs = assembleRequiredPackagingDocs(
    [row("a", 10, 10), row("b", 20, 20)],
    new Set(["a", "b"]),
  );
  assert.equal(
    docs.every((d) => d.approved === true),
    true,
  );
});

// The switch is only a real no-op if "no trim context" means NO trim layer at
// all. An earlier draft gated Monday's label list alone and passed a context
// with `trimLabels: []`, on the theory that an empty list reproduces the
// declared output set. It reproduces the ROWS; it does not reproduce the PAGE.
// These two tests pin the difference so the shortcut cannot come back by
// accident — the second one is the failing half of it.
test("assembleRequiredPackagingDocs — no context ⇒ no kind, no concept copy", () => {
  const docs = assembleRequiredPackagingDocs([row("Wash Care Label", 40, 30)], new Set());
  assert.equal(docs.length, 1);
  assert.equal("kind" in docs[0], false);
  assert.equal("copy" in docs[0], false);
  assert.deepEqual(Object.keys(docs[0]).sort(), [
    "approved",
    "displayName",
    "fileCount",
    "heightMm",
    "widthMm",
  ]);
});

test("assembleRequiredPackagingDocs — an EMPTY label list is NOT the same as no context", () => {
  const docs = assembleRequiredPackagingDocs([row("Wash Care Label", 40, 30)], new Set(), {
    trimLabels: [],
    rules: DEFAULT_TRIM_RULES,
    overrides: {},
    layoutConcepts: {},
    conceptCopy: { CARE_LABEL: { note: "printed on one paper, front and back" } },
  });
  // Same single row — and a standing note under it that the pre-Trims cover
  // never printed. That note is exactly what the switch has to hold back.
  assert.equal(docs.length, 1);
  assert.equal(docs[0].copy?.note, "printed on one paper, front and back");
  assert.notEqual(manifestFingerprint(docs), manifestFingerprint(
    assembleRequiredPackagingDocs([row("Wash Care Label", 40, 30)], new Set()),
  ));
});
