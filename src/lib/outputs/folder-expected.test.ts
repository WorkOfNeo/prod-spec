import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpectedInSupplierFolder } from "./folder-expected";

const base = {
  variantKey: "layout:abc#S-Blue",
  jobAssetId: "a1",
  fileName: "AB10001-S-Care-Label.pdf",
  reviewStatus: "APPROVED" as const,
  placeholderCount: 0,
};

test("an approved, print-safe layout output is expected", () => {
  assert.equal(isExpectedInSupplierFolder(base), true);
});

test("an unapproved layout output is not expected", () => {
  assert.equal(isExpectedInSupplierFolder({ ...base, reviewStatus: "PENDING_REVIEW" }), false);
  assert.equal(isExpectedInSupplierFolder({ ...base, reviewStatus: "REJECTED" }), false);
  assert.equal(isExpectedInSupplierFolder({ ...base, reviewStatus: null }), false);
});

test("the cover IS expected even while it is unapproved", () => {
  // The regression this module exists for: the cover ships without an approval,
  // so an approval-only filter hides it from every folder audit.
  const cover = { ...base, variantKey: "__cover__", reviewStatus: "PENDING_REVIEW" as const };
  assert.equal(isExpectedInSupplierFolder(cover), true);
});

test("a placeholder-carrying cover is still not expected", () => {
  assert.equal(
    isExpectedInSupplierFolder({ ...base, variantKey: "__cover__", reviewStatus: null, placeholderCount: 2 }),
    false,
  );
});

test("no asset or no file name means there is nothing to look for", () => {
  assert.equal(isExpectedInSupplierFolder({ ...base, jobAssetId: null }), false);
  assert.equal(isExpectedInSupplierFolder({ ...base, fileName: null }), false);
  assert.equal(isExpectedInSupplierFolder({ ...base, variantKey: "__cover__", jobAssetId: null }), false);
});

test("general info is NOT given the cover's exemption", () => {
  assert.equal(
    isExpectedInSupplierFolder({ ...base, variantKey: "__general_info__", reviewStatus: "PENDING_REVIEW" }),
    false,
  );
});
