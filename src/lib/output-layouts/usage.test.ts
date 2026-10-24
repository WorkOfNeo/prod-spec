import { test, before } from "node:test";
import assert from "node:assert/strict";

// usage.ts imports the db client, which is constructed at import time — a
// dummy DATABASE_URL lets it load. Only the pure matcher is exercised here.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let layoutOutputsInSpecs: typeof import("./usage").layoutOutputsInSpecs;

before(async () => {
  ({ layoutOutputsInSpecs } = await import("./usage"));
});

const out = (variantKey: string, extra: Record<string, unknown> = {}) => ({
  variantKey,
  widthMm: 50,
  heightMm: 30,
  ...extra,
});

test("an enabled output of the layout counts; other layouts and coded variants do not", () => {
  const specs = [
    { id: "spec-a", outputs: [out("care-label-01"), out("layout:L1")] },
    { id: "spec-b", outputs: [out("layout:L2")] },
    { id: "spec-c", outputs: [out("layout:L10")] }, // prefix of another id ≠ a match
  ];
  const hits = layoutOutputsInSpecs(specs, "L1");
  assert.deepEqual(
    hits.map((h) => h.spec.id),
    ["spec-a"],
  );
  assert.equal(hits[0].output.variantKey, "layout:L1");
  assert.equal(hits[0].output.enabled, true, "parsed outputs carry the schema default");
});

test("a disabled output does not count — only enabled outputs print", () => {
  const specs = [
    { id: "spec-off", outputs: [out("layout:L1", { enabled: false })] },
    { id: "spec-on", outputs: [out("layout:L1", { enabled: true })] },
  ];
  assert.deepEqual(
    layoutOutputsInSpecs(specs, "L1").map((h) => h.spec.id),
    ["spec-on"],
  );
});

test("the first enabled output of the layout is the one returned", () => {
  const specs = [
    {
      id: "spec-a",
      outputs: [
        out("layout:L1", { enabled: false, widthMm: 10 }),
        out("layout:L1", { widthMm: 20 }),
        out("layout:L1", { widthMm: 30 }),
      ],
    },
  ];
  const [hit] = layoutOutputsInSpecs(specs, "L1");
  assert.equal(hit.output.widthMm, 20);
});

test("matching is by base key, so a stray document suffix still names the layout", () => {
  const specs = [{ id: "spec-a", outputs: [out("layout:L1#38-BLACK")] }];
  assert.deepEqual(
    layoutOutputsInSpecs(specs, "L1").map((h) => h.spec.id),
    ["spec-a"],
  );
});

test("a spec whose outputs JSON is malformed is skipped, not fatal", () => {
  const specs = [
    { id: "spec-bad", outputs: [{ variantKey: "layout:L1", widthMm: "wide" }] },
    { id: "spec-empty", outputs: null },
    { id: "spec-legacy", outputs: { WASHCARE: { enabled: true } } },
    { id: "spec-good", outputs: [out("layout:L1")] },
  ];
  assert.deepEqual(
    layoutOutputsInSpecs(specs, "L1").map((h) => h.spec.id),
    ["spec-good"],
  );
});

test("the caller's spec rows come back as given (extra columns kept)", () => {
  const spec = { id: "spec-a", name: "Acme · Shoes", outputs: [out("layout:L1")] };
  const [hit] = layoutOutputsInSpecs([spec], "L1");
  assert.equal(hit.spec, spec);
});
