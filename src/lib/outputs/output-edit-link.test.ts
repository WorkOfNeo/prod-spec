import { test } from "node:test";
import assert from "node:assert/strict";
import { outputEditLink } from "./output-edit-link";

test("layout outputs open the builder (prodSpecId not needed)", () => {
  assert.deepEqual(outputEditLink("layout:abc123", null), {
    href: "/output-builder/abc123",
    label: "Edit output",
  });
  // per-EAN / per-size suffixes resolve to the bare layout id
  assert.deepEqual(outputEditLink("layout:abc123#m-blue", "spec1"), {
    href: "/output-builder/abc123",
    label: "Edit output",
  });
});

test("cover page deep-links to the prod spec cover tab", () => {
  assert.deepEqual(outputEditLink("__cover__", "spec1"), {
    href: "/prod-specs/spec1?tab=cover",
    label: "Edit cover page",
  });
});

test("general info deep-links to the prod spec general tab", () => {
  assert.deepEqual(outputEditLink("__general_info__", "spec1"), {
    href: "/prod-specs/spec1?tab=general",
    label: "Edit general info",
  });
});

test("framing pages without an applied prod spec have no edit link", () => {
  assert.equal(outputEditLink("__cover__", null), null);
  assert.equal(outputEditLink("__general_info__", null), null);
});

test("coded templates / print-spec catalogue outputs have no in-app editor", () => {
  assert.equal(outputEditLink("kaufland-private-label-carton-marking", "spec1"), null);
  assert.equal(outputEditLink("", "spec1"), null);
});
