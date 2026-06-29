import { test } from "node:test";
import assert from "node:assert/strict";
import { styleReadinessNotice, type ReadinessNoticeInput } from "./readiness-notice";
import type { CurrentOutput, OutputState } from "@/lib/outputs/current-outputs";
import type { OutputReadiness } from "@/lib/styles/output-readiness";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const SOURCE_OK = {
  eanStatus: "RESOLVED" as const,
  eanAttempts: 0,
  poNumber: "C-PO61840",
  poFileName: "Purchase Order C-PO61840.pdf",
  hasProdSpec: true,
  prodSpecHasOutputs: true,
};

function output(over: Partial<CurrentOutput> & { state: OutputState }): CurrentOutput {
  return {
    variantKey: over.variantKey ?? `vk-${over.state}`,
    name: over.name ?? "Some output",
    ready: over.ready ?? true,
    missing: over.missing ?? [],
    docType: "OTHER",
    jobId: null,
    fileName: null,
    jobAssetId: null,
    reviewStatus: null,
    reviewedAt: null,
    reviewedById: null,
    rejectReason: null,
    placeholderCount: 0,
    generatedAt: null,
    fromLatestGeneration: false,
    exclusionReason: null,
    ...over,
  };
}

function input(over: Partial<ReadinessNoticeInput>): ReadinessNoticeInput {
  return { ...SOURCE_OK, ...over };
}

// ---------------------------------------------------------------------------

test("all-ready → green headline, no blocking steps", () => {
  const notice = styleReadinessNotice(
    input({
      currentOutputs: [
        output({ state: "APPROVED", variantKey: "a" }),
        output({ state: "TO_REVIEW", variantKey: "b" }),
        output({ state: "APPROVED", variantKey: "c" }),
        output({ state: "TO_REVIEW", variantKey: "d" }),
      ],
    }),
    "ADMIN",
  );
  assert.equal(notice.tone, "green");
  assert.equal(notice.ready, 4);
  assert.equal(notice.total, 4);
  assert.ok(!notice.steps.some((s) => s.tone === "red" || s.tone === "amber"));
});

test("partial fields → amber, reviewer-owned step lists the missing fields", () => {
  const notice = styleReadinessNotice(
    input({
      currentOutputs: [
        output({ state: "TO_REVIEW", variantKey: "a" }),
        output({ state: "TO_REVIEW", variantKey: "b" }),
        output({
          state: "AWAITING_DATA",
          ready: false,
          variantKey: "wash",
          name: "Wash care label",
          missing: [
            { field: "washCare", label: "Wash care" },
            { field: "composition", label: "Composition" },
          ],
        }),
        output({
          state: "AWAITING_DATA",
          ready: false,
          variantKey: "care",
          name: "Care label (front)",
          missing: [{ field: "composition", label: "Composition" }],
        }),
      ],
    }),
    "REVIEWER",
  );
  assert.equal(notice.tone, "amber");
  assert.equal(notice.ready, 2);
  assert.equal(notice.total, 4);
  // Headline is the count (pure missing-fields case, source not blocking).
  assert.equal(notice.headline, "2 of 4 ready");

  const fieldStep = notice.steps.find((s) => s.key === "awaiting-fields");
  assert.ok(fieldStep, "field step present");
  assert.equal(fieldStep!.owner, "REVIEWER");
  assert.equal(fieldStep!.tone, "amber");
  // Per-output breakdown carries both outputs and their fields.
  assert.equal(fieldStep!.outputs?.length, 2);
  // Reviewer copy mentions Monday, not "an admin".
  assert.match(fieldStep!.detail, /Monday/);
  assert.doesNotMatch(fieldStep!.detail, /admin/i);
  // Deduped field union.
  const labels = (fieldStep!.fields ?? []).map((f) => f.label).sort();
  assert.deepEqual(labels, ["Composition", "Wash care"]);
});

test("PO_NOT_FOUND → red admin source step + red headline", () => {
  const notice = styleReadinessNotice(
    input({
      eanStatus: "PO_NOT_FOUND",
      currentOutputs: [output({ state: "AWAITING_DATA", ready: false, variantKey: "a" })],
    }),
    "ADMIN",
  );
  assert.equal(notice.tone, "red");
  assert.equal(notice.headline, "No PO file found");
  const step = notice.steps.find((s) => s.key === "po-not-found");
  assert.ok(step);
  assert.equal(step!.owner, "ADMIN");
});

test("no prod spec → red admin step, output stage short-circuited", () => {
  const notice = styleReadinessNotice(
    input({
      hasProdSpec: false,
      prodSpecHasOutputs: false,
      // Even if outputs were supplied, the missing spec short-circuits them.
      currentOutputs: [output({ state: "TO_REVIEW", variantKey: "a" })],
    }),
    "ADMIN",
  );
  assert.equal(notice.tone, "red");
  assert.equal(notice.headline, "No prod spec");
  const step = notice.steps.find((s) => s.key === "no-prod-spec");
  assert.ok(step);
  assert.equal(step!.owner, "ADMIN");
  // No output steps were appended.
  assert.ok(!notice.steps.some((s) => s.key === "to-review"));
});

test("spec has no outputs → red admin step", () => {
  const notice = styleReadinessNotice(
    input({ prodSpecHasOutputs: false }),
    "ADMIN",
  );
  assert.equal(notice.tone, "red");
  assert.equal(notice.headline, "Spec has no outputs");
  assert.ok(notice.steps.some((s) => s.key === "spec-no-outputs"));
});

test("blocked placeholder → red, blocked step for both roles", () => {
  for (const role of ["ADMIN", "REVIEWER"] as const) {
    const notice = styleReadinessNotice(
      input({
        currentOutputs: [
          output({ state: "TO_REVIEW", variantKey: "a" }),
          output({ state: "BLOCKED", variantKey: "carton", placeholderCount: 2 }),
        ],
      }),
      role,
    );
    assert.equal(notice.tone, "red", `${role} tone`);
    assert.ok(notice.steps.some((s) => s.key === "blocked"), `${role} blocked step`);
  }
});

test("excluded output counted out of the total", () => {
  const notice = styleReadinessNotice(
    input({
      currentOutputs: [
        output({ state: "TO_REVIEW", variantKey: "a" }),
        output({ state: "TO_REVIEW", variantKey: "b" }),
        // EXCLUDED is not in the OutputState union but reaches the selector as
        // a string state; it must be counted OUT of the total.
        output({ state: "EXCLUDED" as OutputState, variantKey: "hangtag" }),
      ],
    }),
    "ADMIN",
  );
  assert.equal(notice.total, 2);
  assert.equal(notice.ready, 2);
  assert.equal(notice.tone, "green");
  const ex = notice.steps.find((s) => s.key === "excluded");
  assert.ok(ex);
  assert.equal(ex!.tone, "zinc");
});

test("headline priority — blocked outranks waiting outranks running", () => {
  // Source waiting (amber) + a blocked output (red) → red wins.
  const both = styleReadinessNotice(
    input({
      eanStatus: "PARTIAL",
      currentOutputs: [output({ state: "BLOCKED", variantKey: "x", placeholderCount: 1 })],
    }),
    "ADMIN",
  );
  assert.equal(both.tone, "red");

  // Running (sky) + waiting (amber) → amber wins.
  const waitVsRun = styleReadinessNotice(
    input({
      currentOutputs: [
        output({ state: "GENERATING", variantKey: "g" }),
        output({
          state: "AWAITING_DATA",
          ready: false,
          variantKey: "w",
          missing: [{ field: "washCare", label: "Wash care" }],
        }),
      ],
    }),
    "ADMIN",
  );
  assert.equal(waitVsRun.tone, "amber");
});

test("light case (OutputReadiness[]) produces the same waiting step", () => {
  const readiness: OutputReadiness[] = [
    { variantKey: "a", name: "Barcode sticker", ready: true, missing: [] },
    {
      variantKey: "wash",
      name: "Wash care label",
      ready: false,
      missing: [{ field: "washCare", label: "Wash care" }],
    },
  ];
  const notice = styleReadinessNotice(
    input({ eanStatus: "RESOLVED", outputReadiness: readiness, hasPdfs: false }),
    "REVIEWER",
  );
  assert.equal(notice.total, 2);
  assert.equal(notice.ready, 1);
  assert.equal(notice.tone, "amber");
  assert.ok(notice.steps.some((s) => s.key === "awaiting-fields"));
});

test("3-strike float → red 'Needs attention' admin step", () => {
  const notice = styleReadinessNotice(
    input({ eanStatus: "PO_NOT_FOUND", eanAttempts: 3 }),
    "ADMIN",
  );
  assert.equal(notice.tone, "red");
  assert.equal(notice.headline, "Needs attention");
  assert.ok(notice.steps.some((s) => s.key === "po-floated"));
});
