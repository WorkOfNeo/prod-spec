import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePointers } from "./explain-ai";
import type { ExplainPointer } from "./explain-ai";

// =====================================================
// resolvePointers is the structural guarantee that the style explainer cannot
// show a reviewer a link the model invented. The model never sees an href — it
// gets ids, returns ids, and this maps them back onto pointers WE built. These
// tests pin that behaviour directly, because it's the one place where a
// regression would turn a fabricated reference into something clickable.
// =====================================================

const OFFERED: ExplainPointer[] = [
  { id: "monday", label: "Monday row", href: "https://monday.com/boards/1/pulses/2" },
  { id: "poEans", label: "PO barcodes", href: "/po-eans" },
  { id: "lookalike", label: "The other row", href: "/styles/abc" },
  { id: "review", label: "Outputs", href: "/styles/abc?tab=review" },
];

test("resolves known ids, preserving the model's ordering", () => {
  const out = resolvePointers(["poEans", "monday"], OFFERED);
  assert.deepEqual(
    out.map((p) => p.id),
    ["poEans", "monday"],
  );
  // The href must come from OUR list, never from anything the model said.
  assert.equal(out[0].href, "/po-eans");
});

test("drops ids that were never offered — a hallucinated pointer cannot surface", () => {
  const out = resolvePointers(["sharepoint-admin-panel", "monday", "https://evil.example"], OFFERED);
  assert.deepEqual(
    out.map((p) => p.id),
    ["monday"],
  );
});

test("an entirely invented id list yields nothing rather than a fallback link", () => {
  assert.deepEqual(resolvePointers(["nope", "also-nope"], OFFERED), []);
});

test("collapses duplicates", () => {
  const out = resolvePointers(["monday", "monday", "poEans"], OFFERED);
  assert.deepEqual(
    out.map((p) => p.id),
    ["monday", "poEans"],
  );
});

test("caps at three so the answer keeps a clear next step", () => {
  const out = resolvePointers(["monday", "poEans", "lookalike", "review"], OFFERED);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((p) => p.id),
    ["monday", "poEans", "lookalike"],
  );
});

test("missing / empty id list yields no pointers", () => {
  assert.deepEqual(resolvePointers(undefined, OFFERED), []);
  assert.deepEqual(resolvePointers([], OFFERED), []);
});

test("no offered pointers means nothing resolves, whatever the model claims", () => {
  assert.deepEqual(resolvePointers(["monday", "poEans"], []), []);
});

test("a pointer with a null href still resolves — the label carries direction", () => {
  const offered: ExplainPointer[] = [{ id: "monday", label: "Monday row", href: null }];
  const out = resolvePointers(["monday"], offered);
  assert.equal(out.length, 1);
  assert.equal(out[0].href, null);
});
