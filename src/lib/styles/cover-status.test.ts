import { test } from "node:test";
import assert from "node:assert/strict";
import { coverStatus, type CoverStatusInput } from "./cover-status";
import { styleReadinessNotice } from "./readiness-notice";

// A style that cleared every gate and has an uploaded cover.
const BASE: CoverStatusInput = {
  hasPo: true,
  poSeq: 62000,
  autoGenerateEnabled: true,
  hasProdSpec: true,
  prodSpecActive: true,
  coverOnly: false,
  generationMinPo: 61500,
  readyOutputs: 2,
  waitingOutputs: 0,
  inFlightJobs: 0,
  failedJobs: 0,
  maxGenAttempts: 3,
  cover: { updatedAt: new Date("2026-10-01T10:00:00Z") },
  realOutputsGenerated: 2,
  hasSupplier: true,
  skipSupplierDelivery: false,
  supplierSendMinPo: 61500,
  queueRow: {
    sharePointStatus: "UPLOADED",
    sharePointError: null,
    pushAttempts: 0,
    lastPushAt: new Date("2026-10-01T10:05:00Z"),
  },
  maxPushAttempts: 3,
};

const NO_COVER = { ...BASE, cover: null, queueRow: null, realOutputsGenerated: 0 };

const state = (over: Partial<CoverStatusInput>) => coverStatus({ ...BASE, ...over }).state;

test("uploaded cover is green", () => {
  const s = coverStatus(BASE);
  assert.equal(s.state, "uploaded");
  assert.equal(s.step.tone, "green");
});

test("no cover: PO (Navision Task) gate wins over everything", () => {
  assert.equal(state({ ...NO_COVER, hasPo: false, autoGenerateEnabled: false, readyOutputs: 0 }), "no-po");
});

test("no cover: generation gates in pipeline order", () => {
  assert.equal(state({ ...NO_COVER, hasProdSpec: false }), "no-prod-spec");
  assert.equal(state({ ...NO_COVER, inFlightJobs: 1, autoGenerateEnabled: false }), "generating");
  assert.equal(state({ ...NO_COVER, autoGenerateEnabled: false, prodSpecActive: false }), "auto-off");
  assert.equal(state({ ...NO_COVER, prodSpecActive: false }), "prod-spec-inactive");
  assert.equal(state({ ...NO_COVER, failedJobs: 3, readyOutputs: 0 }), "floated");
  assert.equal(state({ ...NO_COVER, failedJobs: 2 }), "awaiting-sweep");
});

test("no cover: no ready output explains the wait on data", () => {
  assert.equal(state({ ...NO_COVER, readyOutputs: 0, waitingOutputs: 3 }), "waiting-on-data");
  assert.equal(state({ ...NO_COVER, readyOutputs: 0, waitingOutputs: 0 }), "nothing-to-generate");
  assert.equal(state({ ...NO_COVER, readyOutputs: 0, coverOnly: true }), "cover-only-manual");
});

test("no cover: generation cutoff only when PO parses below it", () => {
  assert.equal(state({ ...NO_COVER, poSeq: 61000 }), "below-generation-cutoff");
  assert.equal(state({ ...NO_COVER, poSeq: null }), "awaiting-sweep");
  assert.equal(state({ ...NO_COVER, poSeq: 61000, generationMinPo: null }), "awaiting-sweep");
});

test("cover exists: supplier-send gates in requeue order", () => {
  assert.equal(state({ hasSupplier: false, skipSupplierDelivery: true }), "no-supplier");
  assert.equal(state({ skipSupplierDelivery: true, poSeq: 1 }), "self-delivering");
  assert.equal(state({ poSeq: 61000 }), "below-send-cutoff");
  assert.equal(state({ poSeq: null }), "below-send-cutoff");
  assert.equal(state({ poSeq: null, supplierSendMinPo: null }), "uploaded");
  assert.equal(state({ realOutputsGenerated: 0 }), "held-no-outputs");
  assert.equal(state({ queueRow: null }), "not-queued");
});

test("cover exists: SharePoint push outcome", () => {
  const row = (over: Partial<NonNullable<CoverStatusInput["queueRow"]>>) =>
    state({ queueRow: { ...BASE.queueRow!, ...over } });
  assert.equal(row({ sharePointStatus: "PENDING" }), "upload-pending");
  assert.equal(row({ sharePointStatus: "NO_FOLDER" }), "no-folder");
  assert.equal(row({ sharePointStatus: "AMBIGUOUS" }), "ambiguous-folder");
  assert.equal(row({ sharePointStatus: "FAILED", pushAttempts: 1 }), "upload-failing");
  assert.equal(row({ sharePointStatus: "FAILED", pushAttempts: 3 }), "upload-gave-up");
  assert.equal(row({ sharePointStatus: "SKIPPED" }), "upload-skipped");
});

test("cover step reaches the readiness headline when it's the only problem", () => {
  const notice = styleReadinessNotice(
    {
      eanStatus: "RESOLVED",
      eanAttempts: 0,
      poNumber: "C-PO62000",
      hasProdSpec: true,
      prodSpecHasOutputs: true,
      outputReadiness: [{ variantKey: "a", name: "A", ready: true, missing: [] }],
      hasPdfs: true,
      coverStep: coverStatus({
        ...BASE,
        queueRow: { ...BASE.queueRow!, sharePointStatus: "NO_FOLDER" },
      }).step,
    },
    "ADMIN",
  );
  assert.equal(notice.headline, "Cover not uploaded: no PO folder");
  assert.equal(notice.tone, "red");
  assert.equal(notice.steps.at(-1)?.key, "cover-no-folder");
});

test("without a cover step the notice is unchanged", () => {
  const notice = styleReadinessNotice(
    {
      eanStatus: "RESOLVED",
      eanAttempts: 0,
      hasProdSpec: true,
      prodSpecHasOutputs: true,
      outputReadiness: [{ variantKey: "a", name: "A", ready: true, missing: [] }],
      hasPdfs: true,
    },
    "ADMIN",
  );
  assert.ok(!notice.steps.some((s) => s.key.startsWith("cover-")));
});
