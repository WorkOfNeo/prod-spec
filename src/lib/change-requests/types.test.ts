import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CodeSpecSchema,
  GapDeclarationSchema,
  ImpactSummarySchema,
  OUTPUT_STATUSES,
  OutputStatusSchema,
  REQUEST_STATUSES,
  REVISION_STATUSES,
  RevisionAuthorKindSchema,
  StepDetailSchema,
  requestRef,
  toolStepKind,
} from "./types";

// The status columns are TEXT, so these unions are the only thing standing
// between a typo and a row no screen knows how to show. Pin the exact sets the
// design names (§4) so a rename is a deliberate, visible change.

test("status unions match the design", () => {
  assert.deepEqual(
    [...REQUEST_STATUSES],
    ["NEW", "WORKING", "IN_REVIEW", "NEEDS_INFO", "NEEDS_CODE", "DONE", "REJECTED"],
  );
  assert.deepEqual(
    [...OUTPUT_STATUSES],
    ["NEW", "WORKING", "IN_REVIEW", "NEEDS_INFO", "NEEDS_CODE", "APPROVED", "PUBLISHED", "REJECTED", "FAILED"],
  );
  assert.deepEqual([...REVISION_STATUSES], ["DRAFT", "PUBLISHED", "DISCARDED", "SUPERSEDED"]);
  assert.equal(OutputStatusSchema.safeParse("DONE").success, false, "DONE is a request status, not an output one");
  assert.equal(RevisionAuthorKindSchema.safeParse("SYSTEM").success, false, "the system never authors a revision");
});

test("requestRef pads to four digits and grows past them", () => {
  assert.equal(requestRef(1), "R-0001");
  assert.equal(requestRef(42), "R-0042");
  assert.equal(requestRef(9999), "R-9999");
  assert.equal(requestRef(12345), "R-12345");
});

test("toolStepKind namespaces tool calls", () => {
  assert.equal(toolStepKind("propose_patch"), "tool:propose_patch");
});

const GAP = {
  tokenKey: "polybagQtyLabel",
  label: "Pieces per polybag, as printed",
  source: {
    board: "Orders",
    column: "Trims",
    examples: [
      { value: "Solid polybag- 5 Pcs / Polybag", count: 12 },
      { value: "Solid polybag", count: 3 },
    ],
  },
  rule: "Print the pieces-per-polybag count followed by PCS, only when above one.",
  cases: [
    { input: "Solid polybag- 5 Pcs / Polybag", output: "5 PCS" },
    { input: "Solid polybag", output: "" },
  ],
};

test("a gap declaration needs a legal token name", () => {
  assert.equal(GapDeclarationSchema.safeParse(GAP).success, true);
  assert.equal(GapDeclarationSchema.safeParse({ ...GAP, tokenKey: "polybag qty" }).success, false);
  assert.equal(GapDeclarationSchema.safeParse({ ...GAP, tokenKey: "1qty" }).success, false);
  assert.equal(GapDeclarationSchema.safeParse({ ...GAP, rule: "" }).success, false);
});

test("a stored code spec is the declaration plus its build prompt", () => {
  assert.equal(CodeSpecSchema.safeParse(GAP).success, false, "buildPrompt is required");
  const parsed = CodeSpecSchema.parse({ ...GAP, buildPrompt: "Add the token …" });
  assert.equal(parsed.buildPrompt, "Add the token …");
  assert.equal(parsed.source.examples[0]?.count, 12);
});

test("impact summary round-trips the design's fields", () => {
  const summary = {
    rows: [
      {
        styleId: "bogus-style-1",
        styleLabel: "Synthetic style",
        poNumber: "PO-0000",
        variantKey: "layout:bogus-id",
        changed: true,
        reviewStatus: "APPROVED",
        uploaded: true,
        emailed: false,
        inFlight: false,
      },
      {
        styleId: "bogus-style-2",
        styleLabel: "Synthetic style 2",
        poNumber: null,
        variantKey: "layout:bogus-id",
        changed: false,
        reviewStatus: "NONE",
        uploaded: false,
        emailed: false,
        inFlight: true,
      },
    ],
    counts: {
      styles: 2,
      docs: 2,
      changed: 1,
      unchanged: 1,
      changedByStatus: { PENDING_REVIEW: 0, APPROVED: 1, REJECTED: 0, NONE: 0 },
      approvedChanged: 1,
      deliveredChanged: 1,
    },
  };
  assert.deepEqual(ImpactSummarySchema.parse(summary), summary);
  // Every review status must be counted, even when zero.
  const missing = { ...summary, counts: { ...summary.counts, changedByStatus: { APPROVED: 1 } } };
  assert.equal(ImpactSummarySchema.safeParse(missing).success, false);
  const badStatus = { ...summary, rows: [{ ...summary.rows[0], reviewStatus: "SENT" }] };
  assert.equal(ImpactSummarySchema.safeParse(badStatus).success, false);
});

test("step detail is any JSON object, never an array or scalar", () => {
  assert.equal(StepDetailSchema.safeParse({ tool: "get_layout", ms: 12 }).success, true);
  assert.equal(StepDetailSchema.safeParse([1, 2]).success, false);
  assert.equal(StepDetailSchema.safeParse("x").success, false);
});
