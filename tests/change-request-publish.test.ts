// Approve → publish → scoped rerun, the explicit rerun of approved documents,
// and reject (src/lib/change-requests/publish.ts).
//
// Every dependency is mocked — revisions, impact, proofs, the bulk-run tail,
// the store, emails, the db — so the tests pin the decisions publish.ts makes
// with them:
//
//   • approve publishes the CURRENT draft only while it is a DRAFT (a
//     superseded one is a 409 with the "ask for a new draft" message), passes
//     conflicts and validation failures through untouched, and computes a
//     FRESH impact of base → published (never the live layout with itself);
//   • the scoped rerun is per style on the base key, skips approved documents
//     (and whole styles that have one), in-flight styles and never-generated
//     documents, and runs as CHANGE_REQUEST;
//   • the output goes PUBLISHED with firstTryApproved = (draftCount === 1)
//     and the fresh summary; everything after the publish is fail-soft;
//   • reject needs a reason, discards the open drafts and tells the requester;
//   • rerunApprovedDocuments sends back only changed APPROVED documents.
//
// Fixtures are synthetic. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ImpactRow, ImpactSummary } from "@/lib/change-requests/types";

type Row = Record<string, unknown>;

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeRevisionStateError extends Error {
  readonly httpStatus = 409;
  constructor(message: string) {
    super(message);
    this.name = "RevisionStateError";
  }
}
class FakeRevisionConflictError extends Error {
  readonly httpStatus = 409;
  constructor(readonly conflict: Row) {
    super("Can't publish: the layout was edited in the Output Builder since this draft was made.");
    this.name = "RevisionConflictError";
  }
}
class FakeRevisionValidationError extends Error {
  readonly httpStatus = 422;
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = "RevisionValidationError";
  }
}

const LAYOUT_ID = "bogus-layout";
const BASE = `layout:${LAYOUT_ID}`;
const BASE_DEF = { pages: [{ id: "p1", marker: "base" }] };
const DRAFT_DEF = { pages: [{ id: "p1", marker: "draft" }] };
const LIVE_EDITED_DEF = { pages: [{ id: "p1", marker: "builder-edit" }] };

let output: Row | null;
let revisions: Record<string, Row>;
let openDrafts: { id: string }[];
let impactRows: ImpactRow[];
let impactThrows: Error | null;
let publishImpl: (id: string, opts: Row) => Promise<Row>;
let enqueueThrows: Error | null;
let currentOutputs: Map<string, { variantKey: string; generatedAt: Date | null }[]>;
let proofThrows = false;

const row = (styleId: string, over: Partial<ImpactRow> = {}): ImpactRow => ({
  styleId,
  styleLabel: `Style ${styleId}`,
  poNumber: "PO-0000",
  variantKey: BASE,
  changed: true,
  reviewStatus: "PENDING_REVIEW",
  uploaded: false,
  emailed: false,
  inFlight: false,
  ...over,
});

function summaryOf(rows: ImpactRow[]): ImpactSummary {
  const changed = rows.filter((r) => r.changed).length;
  return {
    rows,
    counts: {
      styles: new Set(rows.map((r) => r.styleId)).size,
      docs: rows.length,
      changed,
      unchanged: rows.length - changed,
      changedByStatus: { PENDING_REVIEW: 0, APPROVED: 0, REJECTED: 0, NONE: 0 },
      approvedChanged: 0,
      deliveredChanged: 0,
    },
  };
}

const parseLayoutDef = (raw: unknown) => ({ parsed: raw });
const getRevision = mock.fn(async (id: string) => revisions[id] ?? null);
const publishRevision = mock.fn(async (id: string, opts: Row) => publishImpl(id, opts));
const discardDraft = mock.fn(async (id: string) => {
  const rev = revisions[id];
  if (!rev || rev.status !== "DRAFT") throw new FakeRevisionStateError(`Revision ${id} is not a draft`);
  rev.status = "DISCARDED";
});
const computeImpact = mock.fn<(input: Row) => Promise<ImpactSummary>>(async () => {
  if (impactThrows) throw impactThrows;
  return summaryOf(impactRows);
});
const renderProof = mock.fn(async (input: { side: string }) => {
  if (proofThrows) throw new Error("no browser");
  return { png: Buffer.from(input.side), widthMm: 50, heightMm: 30, suffix: null, doc: 0 };
});
const enqueueBulkRun = mock.fn(async (input: { runnable: unknown[] }) => {
  if (enqueueThrows) throw enqueueThrows;
  return { batchId: "batch-1", enqueued: input.runnable.length, skippedNoPo: 0, skippedBelowCutoff: 0, cutoff: null };
});
const getCurrentOutputsForStyles = mock.fn<(ids: readonly string[]) => Promise<typeof currentOutputs>>(
  async () => currentOutputs,
);
const appendMessage = mock.fn(async (m: Row) => ({ id: "msg-1", ...m }));
const setOutputStatus = mock.fn(async (id: string, status: string, patch: Row = {}) => {
  if (output && output.id === id) Object.assign(output, patch, { status });
  return { id, requestId: "req-1" };
});
const sendRequesterUpdate = mock.fn<(...args: unknown[]) => Promise<Row>>(async () => ({ status: "SIMULATED" }));
const styleFindMany = mock.fn(async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.map((id) => ({ id, prodSpecId: `spec-of-${id}` })),
);
const layoutFindUnique = mock.fn(async () => ({ definition: LIVE_EDITED_DEF, version: 7 }));
const revisionFindMany = mock.fn(async () => openDrafts);

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        style: { findMany: styleFindMany },
        outputLayout: { findUnique: layoutFindUnique },
        outputLayoutRevision: { findMany: revisionFindMany },
      },
    },
  });
  mock.module("@/lib/output-layouts/revisions", {
    namedExports: { RevisionStateError: FakeRevisionStateError, discardDraft, getRevision, publishRevision },
  });
  mock.module("@/lib/output-layouts/schema", { namedExports: { parseLayoutDef } });
  mock.module("@/lib/change-requests/impact", { namedExports: { computeImpact } });
  mock.module("@/lib/change-requests/proofs", { namedExports: { renderProof } });
  mock.module("@/lib/queue/bulk-run", { namedExports: { enqueueBulkRun } });
  mock.module("@/lib/outputs/current-outputs", { namedExports: { getCurrentOutputsForStyles } });
  mock.module("@/lib/change-requests/store", {
    namedExports: {
      appendMessage,
      setOutputStatus,
      getOutputWithRequest: async (id: string) => (output && output.id === id ? output : null),
    },
  });
  mock.module("@/lib/change-requests/emails", { namedExports: { sendRequesterUpdate } });
});

beforeEach(() => {
  output = {
    id: "out-1",
    requestId: "req-1",
    label: "Polybag sticker",
    styleId: "style-a",
    status: "IN_REVIEW",
    currentRevisionId: "rev-2",
    draftCount: 1,
    publishedAt: null,
    request: { id: "req-1", number: 12, source: "REQUESTER" },
  };
  revisions = {
    "rev-1": { id: "rev-1", status: "DRAFT", layoutId: LAYOUT_ID },
    "rev-2": {
      id: "rev-2",
      number: 2,
      status: "DRAFT",
      layoutId: LAYOUT_ID,
      definition: DRAFT_DEF,
      baseDefinition: BASE_DEF,
      baseVersion: 3,
      publishedVersion: null,
      publishedAt: null,
    },
  };
  openDrafts = [{ id: "rev-1" }, { id: "rev-2" }];
  impactRows = [
    row("style-a"), // pending, changed → rerun
    row("style-b", { reviewStatus: "APPROVED" }), // approved → waits
    row("style-c", { inFlight: true }), // in flight → skipped
    row("style-d", { reviewStatus: "REJECTED", emailed: true }), // rerun, delivered
    row("style-e", { changed: false }), // unchanged
  ];
  impactThrows = null;
  enqueueThrows = null;
  proofThrows = false;
  currentOutputs = new Map();
  publishImpl = async (id) => {
    const rev = revisions[id];
    rev.status = "PUBLISHED";
    rev.publishedVersion = 4;
    return { revision: { ...rev }, publishedVersion: 4, overrodeConflict: null, superseded: 1 };
  };
  for (const fn of [
    getRevision,
    publishRevision,
    discardDraft,
    computeImpact,
    renderProof,
    enqueueBulkRun,
    getCurrentOutputsForStyles,
    appendMessage,
    setOutputStatus,
    sendRequesterUpdate,
    styleFindMany,
    layoutFindUnique,
    revisionFindMany,
  ]) {
    fn.mock.resetCalls();
  }
});

// ── Pure: planScopedRerun ───────────────────────────────────────────────────

test("planScopedRerun: per style on the base key; approved, in-flight and never-generated documents are not rerun", async () => {
  const { planScopedRerun } = await import("../src/lib/change-requests/publish");
  const rows: ImpactRow[] = [
    row("a", { variantKey: `${BASE}#s` }),
    row("a", { variantKey: `${BASE}#m` }),
    row("a", { variantKey: `${BASE}#l`, changed: false }),
    row("b", { reviewStatus: "APPROVED", uploaded: true }),
    row("c", { inFlight: true }),
    row("d", { reviewStatus: "REJECTED" }),
    row("e", { changed: false, reviewStatus: "APPROVED" }),
    // A split output partly approved: rerunning the style would rerun the
    // approved size too, so the pending one waits with it.
    row("f", { variantKey: `${BASE}#s`, changed: false, reviewStatus: "APPROVED" }),
    row("f", { variantKey: `${BASE}#m` }),
    row("g", { reviewStatus: "NONE" }),
  ];
  const plan = planScopedRerun(rows, new Map([["a", "spec-1"], ["d", "spec-2"]]));
  assert.deepEqual(plan.runnable, [
    { id: "a", prodSpecId: "spec-1", variantKeys: [BASE] },
    { id: "d", prodSpecId: "spec-2", variantKeys: [BASE] },
  ]);
  assert.deepEqual(
    plan.rerunRows.map((r) => `${r.styleId}:${r.variantKey}`),
    [`a:${BASE}#s`, `a:${BASE}#m`, `d:${BASE}`],
  );
  assert.deepEqual(plan.approvedChanged.map((r) => r.styleId), ["b"]);
  assert.deepEqual(plan.deliveredChanged.map((r) => r.styleId), ["b"]);
  assert.deepEqual(plan.skippedInFlight.map((r) => r.styleId), ["c"]);
  assert.deepEqual(plan.heldByApproved.map((r) => r.styleId), ["f"]);
  assert.deepEqual(plan.neverGenerated.map((r) => r.styleId), ["g"]);
});

test("planScopedRerun: a style missing from the ProdSpec map runs with prodSpecId null; nothing changed → nothing planned", async () => {
  const { planScopedRerun } = await import("../src/lib/change-requests/publish");
  assert.deepEqual(planScopedRerun([row("x")], new Map()).runnable, [{ id: "x", prodSpecId: null, variantKeys: [BASE] }]);
  const none = planScopedRerun([row("x", { changed: false })], new Map());
  assert.equal(none.runnable.length + none.approvedChanged.length + none.deliveredChanged.length, 0);
});

test("planApprovedRerun: only changed APPROVED documents, picked styles only, not in flight, not regenerated since", async () => {
  const { planApprovedRerun, docRef } = await import("../src/lib/change-requests/publish");
  const rows: ImpactRow[] = [
    row("a", { reviewStatus: "APPROVED" }),
    row("b", { reviewStatus: "APPROVED" }),
    row("c", { reviewStatus: "APPROVED", inFlight: true }),
    row("d", { reviewStatus: "PENDING_REVIEW" }),
    row("e", { reviewStatus: "APPROVED", changed: false }),
    row("f", { reviewStatus: "APPROVED" }),
  ];
  const plan = planApprovedRerun(rows, {
    styleProdSpec: new Map([["a", "spec-1"]]),
    regenerated: new Set([docRef("f", BASE)]),
  });
  assert.deepEqual(plan.runnable.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(plan.runnable[0], { id: "a", prodSpecId: "spec-1", variantKeys: [BASE] });
  assert.deepEqual(plan.skippedInFlight.map((r) => r.styleId), ["c"]);
  assert.deepEqual(plan.alreadyCurrent.map((r) => r.styleId), ["f"]);

  const picked = planApprovedRerun(rows, { styleProdSpec: new Map(), styleIds: ["b", "d"] });
  assert.deepEqual(picked.runnable.map((r) => r.id), ["b"]);
});

test("summary texts: counts in plain words", async () => {
  const { planScopedRerun, publishSummaryText, rerunApprovedSummaryText, planApprovedRerun } = await import(
    "../src/lib/change-requests/publish"
  );
  const plan = planScopedRerun(
    [row("a"), row("b", { reviewStatus: "APPROVED", uploaded: true }), row("c", { inFlight: true })],
    new Map(),
  );
  const text = publishSummaryText({
    publishedVersion: 5,
    forced: false,
    plan,
    rerun: { enqueued: 1, batchId: "b", skippedNoPo: 0, skippedBelowCutoff: 0 },
  });
  assert.match(text, /^Published as layout version 5\./);
  assert.match(text, /1 changed document rerun on 1 style; they go back to review/);
  assert.match(text, /1 approved document changed and waits for an explicit rerun/);
  assert.match(text, /1 changed document was already delivered to the supplier/);
  assert.match(text, /skipped because a run was already in progress/);

  const failed = publishSummaryText({ publishedVersion: 5, forced: true, plan: null, rerun: null, impactError: "too many styles" });
  assert.match(failed, /published over newer edits/);
  assert.match(failed, /Could not work out which documents changed \(too many styles\), so nothing was rerun/);

  const skipped = publishSummaryText({
    publishedVersion: 2,
    forced: false,
    plan: planScopedRerun([row("a"), row("b")], new Map()),
    rerun: { enqueued: 1, batchId: "b", skippedNoPo: 1, skippedBelowCutoff: 0 },
  });
  assert.match(skipped, /2 changed documents rerun on 1 of 2 styles/);
  assert.match(skipped, /Not rerun: 1 style without a PO number\./);

  const back = rerunApprovedSummaryText({
    plan: planApprovedRerun([row("a", { reviewStatus: "APPROVED" }), row("b", { reviewStatus: "APPROVED" })], {
      styleProdSpec: new Map(),
    }),
    rerun: { enqueued: 2, batchId: "b", skippedNoPo: 0, skippedBelowCutoff: 0 },
  });
  assert.equal(back, "2 approved documents sent back to review; delivery happens only when someone approves them again.");
});

test("normaliseRejectReason: required, trimmed, at most 500 characters", async () => {
  const { normaliseRejectReason, PublishInputError } = await import("../src/lib/change-requests/publish");
  assert.equal(normaliseRejectReason("  Keep the old size  "), "Keep the old size");
  for (const bad of ["", "   ", null, 42, "x".repeat(501)]) {
    assert.throws(() => normaliseRejectReason(bad), PublishInputError);
  }
  assert.equal(normaliseRejectReason("x".repeat(500)).length, 500);
});

// ── approveOutput ───────────────────────────────────────────────────────────

test("approve: publishes the draft, fresh impact base → published, reruns only pending + not in flight as CHANGE_REQUEST", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  const result = await approveOutput("out-1", { userId: "admin-1", userEmail: "admin@example.com" });

  assert.deepEqual(publishRevision.mock.calls[0].arguments, ["rev-2", { userId: "admin-1", force: undefined }]);
  // Fresh impact: what was live before (the base) against the published def —
  // never impactForRevision, which would compare the live layout with itself.
  assert.deepEqual(computeImpact.mock.calls[0].arguments[0], {
    layoutId: LAYOUT_ID,
    proposedDef: { parsed: DRAFT_DEF },
    currentDef: { parsed: BASE_DEF },
  });
  assert.equal(layoutFindUnique.mock.callCount(), 0, "no pre-read without force");

  assert.equal(enqueueBulkRun.mock.callCount(), 1);
  const enq = enqueueBulkRun.mock.calls[0].arguments[0] as unknown as Row;
  assert.equal(enq.triggerSource, "CHANGE_REQUEST");
  assert.equal(enq.label, "R-0012 · Polybag sticker");
  assert.deepEqual(enq.user, { id: "admin-1", email: "admin@example.com" });
  assert.deepEqual(enq.runnable, [
    { id: "style-a", prodSpecId: "spec-of-style-a", variantKeys: [BASE] },
    { id: "style-d", prodSpecId: "spec-of-style-d", variantKeys: [BASE] },
  ]);

  // Output → PUBLISHED with the fresh summary.
  const [id, status, patch] = setOutputStatus.mock.calls[0].arguments as [string, string, Row];
  assert.equal(id, "out-1");
  assert.equal(status, "PUBLISHED");
  assert.equal(patch.approvedById, "admin-1");
  assert.equal(patch.firstTryApproved, true);
  assert.ok(patch.approvedAt instanceof Date && patch.publishedAt instanceof Date);
  assert.deepEqual((patch.impact as ImpactSummary).rows, impactRows);

  // SYSTEM note in the thread.
  const note = appendMessage.mock.calls[0].arguments[0] as Row;
  assert.equal(note.authorKind, "SYSTEM");
  assert.equal(note.outputId, "out-1");
  assert.equal(note.revisionId, "rev-2");
  assert.match(String(note.body), /Published as layout version 4\./);
  assert.match(String(note.body), /2 changed documents rerun on 2 styles/);
  assert.match(String(note.body), /1 approved document changed/);
  assert.equal((note.meta as Row).event, "published");

  // Requester's "live" email with before/after of the output's style.
  assert.deepEqual(
    renderProof.mock.calls.map((c) => c.arguments[0]),
    [
      { revisionId: "rev-2", styleId: "style-a", side: "before" },
      { revisionId: "rev-2", styleId: "style-a", side: "after" },
    ],
  );
  const [reqId, kind, extra] = sendRequesterUpdate.mock.calls[0].arguments as [string, string, Row];
  assert.equal(reqId, "req-1");
  assert.equal(kind, "live");
  assert.equal(extra.outputId, "out-1");
  assert.equal(String(extra.beforePng), "before");
  assert.equal(String(extra.afterPng), "after");

  assert.equal(result.publishedVersion, 4);
  assert.equal(result.forced, false);
  assert.deepEqual(result.rerun, {
    enqueued: 2,
    batchId: "batch-1",
    skippedNoPo: 0,
    skippedBelowCutoff: 0,
    documents: 2,
    skippedInFlight: 1,
    error: null,
  });
  assert.deepEqual(result.approvedChanged.map((r) => r.styleId), ["style-b"]);
  assert.deepEqual(result.deliveredChanged.map((r) => r.styleId), ["style-d"]);
});

test("approve: a second draft is not first-try; an admin's own request gets no email and no proof render", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  output!.draftCount = 2;
  (output!.request as Row).source = "ADMIN";
  await approveOutput("out-1", { userId: "admin-1" });
  assert.equal((setOutputStatus.mock.calls[0].arguments[2] as Row).firstTryApproved, false);
  assert.equal(sendRequesterUpdate.mock.callCount(), 0);
  assert.equal(renderProof.mock.callCount(), 0);
});

test("approve: proofs that fail to render still send the email, without pictures", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  proofThrows = true;
  const warn = mock.method(console, "warn", () => {});
  try {
    await approveOutput("out-1", { userId: "admin-1" });
  } finally {
    warn.mock.restore();
  }
  const extra = sendRequesterUpdate.mock.calls[0].arguments[2] as Row;
  assert.equal(extra.beforePng, undefined);
  assert.equal(extra.afterPng, undefined);
});

test("approve: a superseded or discarded draft → 409 'ask the agent for a new draft', nothing published", async () => {
  const { approveOutput, OutputStateError, REPLACED_DRAFT_MESSAGE } = await import("../src/lib/change-requests/publish");
  const { publishErrorResponse } = await import("../src/lib/change-requests/publish-errors");
  for (const status of ["SUPERSEDED", "DISCARDED"]) {
    revisions["rev-2"].status = status;
    const err = await approveOutput("out-1", { userId: "admin-1" }).catch((e: unknown) => e);
    assert.ok(err instanceof OutputStateError, status);
    assert.equal((err as Error).message, REPLACED_DRAFT_MESSAGE);
    assert.deepEqual(publishErrorResponse(err), { status: 409, body: { error: REPLACED_DRAFT_MESSAGE } });
  }
  assert.equal(publishRevision.mock.callCount(), 0);
  assert.equal(setOutputStatus.mock.callCount(), 0);
});

test("approve: an output not in review, or in review without a draft, → 409", async () => {
  const { approveOutput, OutputStateError, OutputNotFoundError } = await import("../src/lib/change-requests/publish");
  output!.status = "WORKING";
  await assert.rejects(approveOutput("out-1", { userId: "admin-1" }), OutputStateError);
  output!.status = "IN_REVIEW";
  output!.currentRevisionId = null;
  await assert.rejects(approveOutput("out-1", { userId: "admin-1" }), /no draft to approve/);
  await assert.rejects(approveOutput("nope", { userId: "admin-1" }), OutputNotFoundError);
  assert.equal(publishRevision.mock.callCount(), 0);
});

test("approve: a publish conflict passes through (409 with the conflict); a failing gate passes through as 422", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  const { publishErrorResponse } = await import("../src/lib/change-requests/publish-errors");
  const conflict = { baseVersion: 3, liveVersion: 3, versionChanged: false, definitionChanged: true };
  publishImpl = async () => {
    throw new FakeRevisionConflictError(conflict);
  };
  const err = await approveOutput("out-1", { userId: "admin-1" }).catch((e: unknown) => e);
  assert.ok(err instanceof FakeRevisionConflictError);
  const mapped = publishErrorResponse(err);
  assert.equal(mapped?.status, 409);
  assert.deepEqual(mapped?.body.conflict, conflict);

  publishImpl = async () => {
    throw new FakeRevisionValidationError("Layout has invalid tokens", ["Unknown token {{nope}}"]);
  };
  const invalid = publishErrorResponse(await approveOutput("out-1", { userId: "admin-1" }).catch((e: unknown) => e));
  assert.deepEqual(invalid, { status: 422, body: { error: "Layout has invalid tokens", details: ["Unknown token {{nope}}"] } });

  assert.equal(computeImpact.mock.callCount(), 0);
  assert.equal(enqueueBulkRun.mock.callCount(), 0);
  assert.equal(setOutputStatus.mock.callCount(), 0);
});

test("approve with force over a conflict: the impact's 'before' is what was live just before the publish", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  publishImpl = async (id) => {
    revisions[id].status = "PUBLISHED";
    return {
      revision: { ...revisions[id] },
      publishedVersion: 4,
      overrodeConflict: { baseVersion: 3, liveVersion: 3, versionChanged: false, definitionChanged: true },
    };
  };
  const result = await approveOutput("out-1", { userId: "admin-1", force: true });
  assert.deepEqual(publishRevision.mock.calls[0].arguments, ["rev-2", { userId: "admin-1", force: true }]);
  assert.deepEqual((computeImpact.mock.calls[0].arguments[0] as Row).currentDef, { parsed: LIVE_EDITED_DEF });
  assert.equal(result.forced, true);
});

test("approve: an impact that fails after the publish still marks the output live, reruns nothing, says so", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  impactThrows = new Error("This layout prints on more than 400 styles");
  const errors = mock.method(console, "error", () => {});
  let result;
  try {
    result = await approveOutput("out-1", { userId: "admin-1" });
  } finally {
    errors.mock.restore();
  }
  assert.equal(enqueueBulkRun.mock.callCount(), 0);
  assert.equal(setOutputStatus.mock.calls[0].arguments[1], "PUBLISHED");
  assert.equal("impact" in (setOutputStatus.mock.calls[0].arguments[2] as Row), false);
  assert.match(result.impactError ?? "", /more than 400 styles/);
  assert.match(String((appendMessage.mock.calls[0].arguments[0] as Row).body), /nothing was rerun/);
});

test("approve: an enqueue that fails after the publish is recorded, not thrown", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  enqueueThrows = new Error("queue down");
  const errors = mock.method(console, "error", () => {});
  let result;
  try {
    result = await approveOutput("out-1", { userId: "admin-1" });
  } finally {
    errors.mock.restore();
  }
  assert.equal(result.rerun.error, "queue down");
  assert.equal(result.rerun.enqueued, 0);
  assert.equal(setOutputStatus.mock.calls[0].arguments[1], "PUBLISHED");
  assert.match(String((appendMessage.mock.calls[0].arguments[0] as Row).body), /could not be started \(queue down\)/);
});

test("approve: a draft already published (History panel, or an approval that died) finishes the bookkeeping", async () => {
  const { approveOutput } = await import("../src/lib/change-requests/publish");
  Object.assign(revisions["rev-2"], { status: "PUBLISHED", publishedVersion: 9 });
  const result = await approveOutput("out-1", { userId: "admin-1" });
  assert.equal(publishRevision.mock.callCount(), 0);
  assert.equal(result.publishedVersion, 9);
  assert.equal(enqueueBulkRun.mock.callCount(), 1);
  assert.equal(setOutputStatus.mock.calls[0].arguments[1], "PUBLISHED");
});

test("approve: a second approval of the same output while one runs → 409, published once", async () => {
  const { approveOutput, OutputStateError } = await import("../src/lib/change-requests/publish");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = publishImpl;
  publishImpl = async (id, opts) => {
    await gate;
    return original(id, opts);
  };
  const first = approveOutput("out-1", { userId: "admin-1" });
  await assert.rejects(approveOutput("out-1", { userId: "admin-2" }), OutputStateError);
  release();
  await first;
  assert.equal(publishRevision.mock.callCount(), 1);
});

// ── rejectOutput ────────────────────────────────────────────────────────────

test("reject: a reason is required — nothing is discarded or changed without one", async () => {
  const { rejectOutput, PublishInputError } = await import("../src/lib/change-requests/publish");
  await assert.rejects(rejectOutput("out-1", { userId: "admin-1", reason: "   " }), PublishInputError);
  assert.equal(discardDraft.mock.callCount(), 0);
  assert.equal(setOutputStatus.mock.callCount(), 0);
});

test("reject: discards the current draft and the output's other open drafts, REJECTED with the reason, requester told", async () => {
  const { rejectOutput } = await import("../src/lib/change-requests/publish");
  const result = await rejectOutput("out-1", { userId: "admin-1", reason: "  The old size was right  " });
  assert.deepEqual(
    discardDraft.mock.calls.map((c) => c.arguments[0]),
    ["rev-2", "rev-1"],
  );
  assert.equal(revisions["rev-2"].status, "DISCARDED");
  assert.deepEqual(setOutputStatus.mock.calls[0].arguments, ["out-1", "REJECTED", { rejectReason: "The old size was right" }]);
  const note = appendMessage.mock.calls[0].arguments[0] as Row;
  assert.equal(note.authorKind, "SYSTEM");
  assert.match(String(note.body), /Reason: The old size was right$/);
  assert.deepEqual(sendRequesterUpdate.mock.calls[0].arguments, [
    "req-1",
    "rejected",
    { outputId: "out-1", message: "The old size was right" },
  ]);
  assert.deepEqual(result, { discarded: 2, reason: "The old size was right" });
});

test("reject: refused while the agent works, once live, or when the draft is already published", async () => {
  const { rejectOutput, OutputStateError } = await import("../src/lib/change-requests/publish");
  for (const status of ["WORKING", "PUBLISHED", "REJECTED"]) {
    output!.status = status;
    await assert.rejects(rejectOutput("out-1", { userId: "admin-1", reason: "No" }), OutputStateError, status);
  }
  output!.status = "IN_REVIEW";
  revisions["rev-2"].status = "PUBLISHED";
  await assert.rejects(rejectOutput("out-1", { userId: "admin-1", reason: "No" }), /already live/);
  assert.equal(discardDraft.mock.callCount(), 0);
  assert.equal(setOutputStatus.mock.callCount(), 0);
});

// ── rerunApprovedDocuments ──────────────────────────────────────────────────

test("rerun approved: only changed APPROVED documents not regenerated since the publish, as CHANGE_REQUEST_APPROVED", async () => {
  const { rerunApprovedDocuments } = await import("../src/lib/change-requests/publish");
  const publishedAt = new Date("2026-10-20T10:00:00Z");
  output!.status = "PUBLISHED";
  Object.assign(revisions["rev-2"], { status: "PUBLISHED", publishedAt, publishedVersion: 4 });
  impactRows = [
    row("style-a", { reviewStatus: "APPROVED" }),
    row("style-b", { reviewStatus: "APPROVED" }), // re-approved after the publish
    row("style-c", { reviewStatus: "PENDING_REVIEW" }),
    row("style-d", { reviewStatus: "APPROVED", changed: false }),
    row("style-e", { reviewStatus: "APPROVED", inFlight: true }),
  ];
  currentOutputs = new Map([
    ["style-a", [{ variantKey: BASE, generatedAt: new Date("2026-10-01T10:00:00Z") }]],
    ["style-b", [{ variantKey: BASE, generatedAt: new Date("2026-10-21T10:00:00Z") }]],
  ]);

  const result = await rerunApprovedDocuments("out-1", { userId: "admin-1", userEmail: "admin@example.com" });

  assert.deepEqual(computeImpact.mock.calls[0].arguments[0], {
    layoutId: LAYOUT_ID,
    proposedDef: { parsed: DRAFT_DEF },
    currentDef: { parsed: BASE_DEF },
  });
  const enq = enqueueBulkRun.mock.calls[0].arguments[0] as unknown as Row;
  // The only change-request trigger the runner lets regenerate approved documents.
  assert.equal(enq.triggerSource, "CHANGE_REQUEST_APPROVED");
  assert.deepEqual(enq.runnable, [{ id: "style-a", prodSpecId: "spec-of-style-a", variantKeys: [BASE] }]);
  assert.equal(result.documents, 1);
  assert.equal(result.skippedInFlight, 1);
  assert.equal(result.alreadyCurrent, 1);
  const note = appendMessage.mock.calls[0].arguments[0] as Row;
  assert.equal(
    note.body,
    "1 approved document sent back to review; delivery happens only when someone approves them again. 1 document skipped because a run is in progress for its style.",
  );
  assert.deepEqual((note.meta as Row).styleIds, ["style-a"]);
});

test("rerun approved: limited to the picked styles; nothing to send → no job, no note", async () => {
  const { rerunApprovedDocuments } = await import("../src/lib/change-requests/publish");
  output!.status = "PUBLISHED";
  Object.assign(revisions["rev-2"], { status: "PUBLISHED", publishedAt: new Date() });
  impactRows = [row("style-a", { reviewStatus: "APPROVED" }), row("style-b", { reviewStatus: "APPROVED" })];

  await rerunApprovedDocuments("out-1", { userId: "admin-1", styleIds: ["style-b"] });
  assert.deepEqual((enqueueBulkRun.mock.calls[0].arguments[0] as unknown as Row).runnable, [
    { id: "style-b", prodSpecId: "spec-of-style-b", variantKeys: [BASE] },
  ]);

  enqueueBulkRun.mock.resetCalls();
  appendMessage.mock.resetCalls();
  const none = await rerunApprovedDocuments("out-1", { userId: "admin-1", styleIds: ["style-z"] });
  assert.equal(none.enqueued, 0);
  assert.equal(enqueueBulkRun.mock.callCount(), 0);
  assert.equal(appendMessage.mock.callCount(), 0);
});

test("rerun approved: refused unless the output is live", async () => {
  const { rerunApprovedDocuments, OutputStateError } = await import("../src/lib/change-requests/publish");
  await assert.rejects(rerunApprovedDocuments("out-1", { userId: "admin-1" }), OutputStateError);
  output!.status = "PUBLISHED"; // but the draft never was
  await assert.rejects(rerunApprovedDocuments("out-1", { userId: "admin-1" }), /could not be found/);
  assert.equal(computeImpact.mock.callCount(), 0);
  assert.equal(enqueueBulkRun.mock.callCount(), 0);
});
