import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCurrentOutputs,
  type CurrentOutput,
  type CurrentOutputAsset,
} from "./current-outputs";
import type { OutputReadiness } from "@/lib/styles/output-readiness";

// deriveCurrentOutputs is the pure half of getCurrentOutputsForStyle AND its
// batch twin, so these pin the derivation both loaders share. The DB-backed
// parity (single read vs batch read on a real database) is
// scripts/perf/parity-current-outputs.ts.

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
let seq = 0;

function asset(
  jobId: string,
  variantKey: string | null,
  opts: Partial<CurrentOutputAsset> = {},
): CurrentOutputAsset {
  seq++;
  return {
    id: `asset-${seq}`,
    jobId,
    variantKey,
    docType: "CARE_LABEL",
    fileName: `${variantKey ?? "legacy"}.pdf`,
    displayName: null,
    reviewStatus: "PENDING_REVIEW",
    reviewedAt: null,
    reviewedById: null,
    rejectReason: null,
    placeholderCount: 0,
    createdAt: new Date(T0 + seq * 1000),
    updatedAt: new Date(T0 + seq * 1000 + 500),
    ...opts,
  };
}

function declared(variantKey: string, opts: Partial<OutputReadiness> = {}): OutputReadiness {
  return { variantKey, name: `Declared ${variantKey}`, ready: true, missing: [], ...opts };
}

const VARIANTS: Record<string, { name: string; docType: string }> = {
  "care-label-02": { name: "Care Label 02", docType: "CARE_LABEL" },
  carton: { name: "Carton marking", docType: "CARTON_MARKING" },
  washcare: { name: "Wash care", docType: "WASHCARE" },
  sticker: { name: "Sticker", docType: "STICKER" },
};
const variantOf = (b: string) => VARIANTS[b];

function derive(p: {
  readiness?: OutputReadiness[];
  declaredBaseKeys?: string[];
  assets?: CurrentOutputAsset[];
  inflight?: unknown[];
}): CurrentOutput[] {
  const readiness = p.readiness ?? [];
  return deriveCurrentOutputs({
    readiness,
    declaredBaseKeys: new Set(p.declaredBaseKeys ?? readiness.map((r) => r.variantKey)),
    assets: p.assets ?? [],
    inflight: (p.inflight ?? []).map((variantKeys) => ({ variantKeys })),
    variantOf,
  });
}

const row = (outputs: CurrentOutput[], variantKey: string) => {
  const o = outputs.find((x) => x.variantKey === variantKey);
  assert.ok(o, `no output ${variantKey}`);
  return o;
};

test("deriveCurrentOutputs — nothing declared, nothing generated → []", () => {
  assert.deepEqual(derive({}), []);
});

test("deriveCurrentOutputs — multi-job rerun: newest job wins per base, older bases stay", () => {
  // job2 (newest) re-ran care-label-02 only; carton's latest document is still
  // the approved one from job1.
  const outputs = derive({
    readiness: [declared("care-label-02"), declared("carton")],
    assets: [
      asset("job2", "care-label-02"),
      asset("job1", "care-label-02", { reviewStatus: "REJECTED", rejectReason: "typo" }),
      asset("job1", "carton", { reviewStatus: "APPROVED", reviewedById: "u1" }),
    ],
  });
  assert.deepEqual(
    outputs.map((o) => [o.variantKey, o.state, o.jobId, o.fromLatestGeneration]),
    [
      ["care-label-02", "TO_REVIEW", "job2", true],
      ["carton", "APPROVED", "job1", false],
    ],
  );
  assert.equal(row(outputs, "carton").reviewedById, "u1");
  assert.equal(row(outputs, "care-label-02").rejectReason, null);
});

test("deriveCurrentOutputs — multi-document output: one row per document, no declared row", () => {
  const outputs = derive({
    readiness: [declared("carton")],
    assets: [
      asset("job1", "carton#S", { docType: "CARTON_MARKING", displayName: "Carton · S" }),
      asset("job1", "carton#M", { docType: "CARTON_MARKING", placeholderCount: 2 }),
    ],
  });
  assert.deepEqual(
    outputs.map((o) => [o.variantKey, o.name, o.state]),
    [
      ["carton#S", "Carton · S", "TO_REVIEW"],
      // No displayName → the declared output's name for its base.
      ["carton#M", "Declared carton", "BLOCKED"],
    ],
  );
});

test("deriveCurrentOutputs — a doc-type exclusion drops the stale asset and re-emits EXCLUDED", () => {
  const outputs = derive({
    readiness: [
      declared("washcare", {
        ready: false,
        missing: [{ field: "composition", label: "Composition" }],
        excluded: true,
        exclusionReason: "Not generated — Product group contains “socks” (Wash care rule)",
      }),
    ],
    assets: [asset("job1", "washcare", { docType: "WASHCARE", reviewStatus: "REJECTED" })],
    inflight: [["washcare"]],
  });
  assert.equal(outputs.length, 1);
  const o = outputs[0];
  // Exclusion wins over an in-flight regen, and its missing fields are moot.
  assert.equal(o.state, "EXCLUDED");
  assert.deepEqual(o.missing, []);
  assert.equal(o.jobAssetId, null);
  assert.equal(o.docType, "WASHCARE");
  assert.equal(o.exclusionReason, "Not generated — Product group contains “socks” (Wash care rule)");
  assert.equal(o.ignored, false);
});

test("deriveCurrentOutputs — an operator ignore reads EXCLUDED + ignored", () => {
  const outputs = derive({
    readiness: [
      declared("sticker", {
        excluded: true,
        ignored: true,
        exclusionReason: "ignored for this style by a reviewer",
      }),
    ],
    assets: [asset("job1", "sticker", { docType: "STICKER" })],
  });
  assert.deepEqual(
    outputs.map((o) => [o.variantKey, o.state, o.ignored, o.exclusionReason]),
    [["sticker", "EXCLUDED", true, "ignored for this style by a reviewer"]],
  );
});

test("deriveCurrentOutputs — in-flight subset marks only its bases GENERATING", () => {
  const outputs = derive({
    readiness: [declared("care-label-02"), declared("carton"), declared("sticker", { ready: false })],
    assets: [asset("job1", "care-label-02", { reviewStatus: "APPROVED" })],
    inflight: [["care-label-02"], ["carton#S"]],
  });
  assert.deepEqual(
    outputs.map((o) => [o.variantKey, o.state]),
    [
      ["care-label-02", "GENERATING"],
      ["carton", "GENERATING"],
      ["sticker", "AWAITING_DATA"],
    ],
  );
});

test("deriveCurrentOutputs — an in-flight full run (no variantKeys) marks everything GENERATING", () => {
  const outputs = derive({
    readiness: [declared("care-label-02"), declared("carton", { ready: false })],
    assets: [asset("job1", "care-label-02")],
    // A non-array variantKeys JSON counts as a full run too.
    inflight: [null],
  });
  assert.deepEqual(
    outputs.map((o) => o.state),
    ["GENERATING", "GENERATING"],
  );
});

test("deriveCurrentOutputs — orphans dropped, framing + legacy kept, general info skipped", () => {
  const outputs = derive({
    readiness: [declared("care-label-02")],
    assets: [
      asset("job1", "__cover__", { docType: "COVER" }),
      asset("job1", "__general_info__", { docType: "GENERAL_INFO" }),
      asset("job1", "layout:gone#A", { docType: "STICKER" }),
      asset("job1", null, { docType: "HANGTAG" }),
    ],
  });
  assert.deepEqual(
    outputs.map((o) => [o.variantKey, o.name, o.state]),
    [
      // No displayName, not declared, not in the registry → the docType.
      ["__cover__", "COVER", "TO_REVIEW"],
      ["doc:HANGTAG", "HANGTAG", "TO_REVIEW"],
      ["care-label-02", "Declared care-label-02", "READY_TO_GENERATE"],
    ],
  );
});

test("deriveCurrentOutputs — names and doc types fall back to the registry", () => {
  const outputs = derive({
    // carton is declared but disabled: not orphaned, yet absent from readiness,
    // so its name can only come from the registry.
    readiness: [declared("unknown-variant")],
    declaredBaseKeys: ["unknown-variant", "carton"],
    assets: [asset("job1", "carton", { docType: "CARTON_MARKING" })],
  });
  assert.equal(row(outputs, "carton").name, "Carton marking");
  // A declared row the registry doesn't know gets docType OTHER.
  assert.equal(row(outputs, "unknown-variant").docType, "OTHER");
});

test("deriveCurrentOutputs — document fields carry through from the asset", () => {
  const a = asset("job7", "care-label-02", {
    reviewStatus: "REJECTED",
    reviewedAt: new Date(T0),
    reviewedById: "u2",
    rejectReason: "wrong composition",
    placeholderCount: 1,
  });
  const [o] = derive({ readiness: [declared("care-label-02")], assets: [a] });
  assert.deepEqual(o, {
    variantKey: "care-label-02",
    name: "Declared care-label-02",
    state: "REJECTED",
    ready: true,
    missing: [],
    docType: "CARE_LABEL",
    jobId: "job7",
    fileName: a.fileName,
    jobAssetId: a.id,
    reviewStatus: "REJECTED",
    reviewedAt: new Date(T0),
    reviewedById: "u2",
    rejectReason: "wrong composition",
    placeholderCount: 1,
    generatedAt: a.createdAt,
    assetVersion: a.updatedAt.getTime(),
    fromLatestGeneration: true,
    exclusionReason: null,
    ignored: false,
  });
});

test("deriveCurrentOutputs — output order follows asset order, then declared order", () => {
  // The loaders' total asset order is what keeps single and batch identical;
  // this pins that the derivation itself preserves it.
  const assets = [asset("job1", "sticker"), asset("job1", "care-label-02"), asset("job1", "carton")];
  const readiness = [declared("care-label-02"), declared("washcare"), declared("carton"), declared("sticker")];
  assert.deepEqual(
    derive({ readiness, assets }).map((o) => o.variantKey),
    ["sticker", "care-label-02", "carton", "washcare"],
  );
  assert.deepEqual(
    derive({ readiness, assets: [...assets].reverse() }).map((o) => o.variantKey),
    ["carton", "care-label-02", "sticker", "washcare"],
  );
});
