import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SIZE_JOIN_ARG, validateTokenRef } from "./token-meta";
import type { StyleData } from "@/lib/pdf/types";

// tokens.ts transitively imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("./tokens").resolveTextToken;

before(async () => {
  ({ resolveTextToken } = await import("./tokens"));
});

function styleWithSizes(labels: string[]): StyleData {
  const sizes = labels.map((label) => ({ label, ean13: "" }));
  return { sizes, allSizes: sizes, carton: {} } as unknown as StyleData;
}

const RUN = ["S", "M", "L", "XL", "2XL", "3XL"];

test("bare size tokens keep the comma join every existing layout prints", () => {
  const s = styleWithSizes(RUN);
  assert.equal(resolveTextToken(s, "sizes"), "S, M, L, XL, 2XL, 3XL");
  assert.equal(resolveTextToken(s, "sizeRange"), "S, M, L, XL, 2XL, 3XL");
});

test(":dash joins with hyphens — the form the stickers ask for", () => {
  const s = styleWithSizes(RUN);
  assert.equal(resolveTextToken(s, "sizes", SIZE_JOIN_ARG), "S-M-L-XL-2XL-3XL");
  assert.equal(resolveTextToken(s, "sizeRange", SIZE_JOIN_ARG), "S-M-L-XL-2XL-3XL");
});

test("a size whose own label contains a slash is not mangled", () => {
  // Kids' runs are written "86/92" — the dash join must not touch them.
  const s = styleWithSizes(["86/92", "98/104", "110/116"]);
  assert.equal(resolveTextToken(s, "sizeRange", SIZE_JOIN_ARG), "86/92-98/104-110/116");
});

test("an empty run stays empty rather than printing a stray separator", () => {
  assert.equal(resolveTextToken(styleWithSizes([]), "sizeRange", SIZE_JOIN_ARG), "");
});

test(":dash is the only accepted option; a typo is a publish blocker", () => {
  assert.deepEqual(validateTokenRef("sizeRange", SIZE_JOIN_ARG), []);
  assert.deepEqual(validateTokenRef("sizeRange", undefined), []);
  assert.equal(validateTokenRef("sizeRange", "hyphen").length, 1);
});
