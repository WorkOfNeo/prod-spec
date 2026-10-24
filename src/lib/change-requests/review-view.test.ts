// The review screen's view of a request (review-view.ts): who may see it, what
// an admin sees, what the filing reviewer sees, and how the approval's thread
// note becomes the "live" panel. Pure builders only; fixtures are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RequestDetail } from "./store";
import {
  buildRequestView,
  canSeeRequest,
  memoryIdOf,
  publishedInfoFor,
  redactForRequester,
  type ReviewViewer,
} from "./review-view";

const T0 = new Date("2026-10-20T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function message(over: Partial<RequestDetail["messages"][number]>): RequestDetail["messages"][number] {
  return {
    id: "m",
    requestId: "req-1",
    outputId: "out-1",
    authorKind: "SYSTEM",
    authorUserId: null,
    kind: "status",
    body: "",
    revisionId: null,
    meta: null,
    createdAt: T0,
    ...over,
  };
}

function detail(): RequestDetail {
  return {
    id: "req-1",
    number: 7,
    title: "Polybag sticker · PO-0000",
    status: "IN_REVIEW",
    message: "The quantity is missing",
    source: "REQUESTER",
    createdById: "reviewer-1",
    customerId: null,
    poNumber: "PO-0000",
    styleId: "style-1",
    createdAt: T0,
    updatedAt: T0,
    outputs: [
      {
        id: "out-1",
        requestId: "req-1",
        position: 0,
        label: "Polybag sticker",
        variantKey: "layout:bogus-layout",
        layoutId: "bogus-layout",
        styleId: "style-1",
        text: "Show the pack quantity",
        status: "IN_REVIEW",
        currentRevisionId: "rev-2",
        draftCount: 2,
        awaitingToken: null,
        codeSpec: null,
        impact: { not: "an impact summary" },
        rejectReason: null,
        approvedById: null,
        approvedAt: null,
        publishedAt: null,
        firstTryApproved: null,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    attachments: [
      { id: "att-1", outputId: "out-1", mimeType: "image/png", fileName: "shot.png", byteSize: 10, createdAt: T0 },
      { id: "att-2", outputId: null, mimeType: "image/png", fileName: "all.png", byteSize: 20, createdAt: T0 },
    ],
    messages: [
      message({ id: "m1", kind: "status", body: "Request received", outputId: null }),
      message({ id: "m2", authorKind: "AGENT", kind: "message", body: "Draft ready", revisionId: "rev-2", createdAt: at(1) }),
      message({ id: "m3", authorKind: "USER", authorUserId: "admin-1", kind: "message", body: "Bold please", createdAt: at(2) }),
      message({
        id: "m4",
        authorKind: "AGENT",
        kind: "memory_suggestion",
        body: "Quantities in bold for this customer",
        meta: { memoryId: "mem-1" },
        createdAt: at(3),
      }),
    ],
    steps: [
      {
        id: "s1",
        requestId: "req-1",
        outputId: "out-1",
        kind: "model_turn",
        summary: "Turn 1",
        model: "a-model",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
        detail: null,
        createdAt: at(1),
      },
    ],
  } as RequestDetail;
}

const revisions = [
  {
    id: "rev-1",
    number: 1,
    status: "SUPERSEDED",
    authorKind: "AGENT",
    note: null,
    parentRevisionId: null,
    publishedVersion: null,
    changeRequestOutputId: "out-1",
    createdAt: T0,
  },
  {
    id: "rev-2",
    number: 2,
    status: "DRAFT",
    authorKind: "AGENT",
    note: null,
    parentRevisionId: "rev-1",
    publishedVersion: null,
    changeRequestOutputId: "out-1",
    createdAt: at(1),
  },
];

const admin: ReviewViewer = { userId: "admin-1", role: "ADMIN" };
const creator: ReviewViewer = { userId: "reviewer-1", role: "REVIEWER" };

function build(viewer: ReviewViewer) {
  return buildRequestView({
    detail: detail(),
    revisions,
    emails: new Map([
      ["admin-1", "admin@example.com"],
      ["reviewer-1", "reviewer@example.com"],
    ]),
    memories: new Map([["mem-1", { id: "mem-1", state: "PROPOSED", text: "Quantities in bold", scope: "CUSTOMER" }]]),
    viewer,
    now: 123,
  });
}

test("canSeeRequest: admins always, the filing reviewer only, nobody else", () => {
  assert.equal(canSeeRequest(admin, "reviewer-1"), true);
  assert.equal(canSeeRequest(creator, "reviewer-1"), true);
  assert.equal(canSeeRequest({ userId: "reviewer-2", role: "REVIEWER" }, "reviewer-1"), false);
  assert.equal(canSeeRequest({ userId: "reviewer-1", role: null }, "reviewer-1"), false);
});

test("admin view: revisions newest first, attachments split per output, memory card resolved, run log kept", () => {
  const view = build(admin);
  assert.equal(view.generatedAt, 123);
  assert.equal(view.ref, "R-0007");
  assert.equal(view.admin, true);
  assert.equal(view.requester, "reviewer@example.com");
  const out = view.outputs[0];
  assert.deepEqual(out.revisions.map((r) => r.id), ["rev-2", "rev-1"]);
  assert.deepEqual(out.attachments.map((a) => a.id), ["att-1"]);
  assert.deepEqual(view.generalAttachments.map((a) => a.id), ["att-2"]);
  // A stored impact that doesn't parse is shown as none, not as garbage.
  assert.equal(out.impact, null);
  assert.equal(view.messages.find((m) => m.id === "m3")?.author, "You");
  assert.equal(view.messages.find((m) => m.id === "m2")?.author, "Assistant");
  assert.deepEqual(view.messages.find((m) => m.id === "m4")?.memory, {
    id: "mem-1",
    state: "PROPOSED",
    text: "Quantities in bold",
    scope: "CUSTOMER",
  });
  assert.equal(view.steps.length, 1);
});

test("requester view: no drafts, impact, run log or memory cards; other people are 'Admin'", () => {
  const view = redactForRequester(build(creator));
  assert.equal(view.admin, false);
  assert.equal(view.requester, "You");
  const out = view.outputs[0];
  assert.deepEqual(out.revisions, []);
  assert.equal(out.currentRevisionId, null);
  assert.equal(out.impact, null);
  assert.equal(out.text, "Show the pack quantity");
  assert.deepEqual(out.attachments.map((a) => a.id), ["att-1"]);
  assert.deepEqual(view.steps, []);
  assert.equal(view.messages.some((m) => m.kind === "memory_suggestion"), false);
  assert.equal(view.messages.find((m) => m.id === "m3")?.author, "Admin");
});

test("publishedInfoFor: the latest 'published' note, plus styles sent back to review after it", () => {
  const messages = [
    message({ id: "p0", meta: { event: "published", publishedVersion: 2 }, createdAt: at(0) }),
    message({ id: "r0", meta: { event: "rerun_approved", styleIds: ["old"] }, createdAt: at(1) }),
    message({
      id: "p1",
      body: "Published as layout version 3.",
      meta: {
        event: "published",
        publishedVersion: 3,
        forced: true,
        rerun: { enqueued: 2, documents: 3, skippedNoPo: 1, skippedBelowCutoff: 0, skippedInFlight: 0, error: null },
        approvedChanged: 4,
        deliveredChanged: 1,
        impactError: null,
      },
      createdAt: at(2),
    }),
    message({ id: "r1", meta: { event: "rerun_approved", styleIds: ["style-9", 42] }, createdAt: at(3) }),
    message({ id: "x", outputId: "out-2", meta: { event: "published", publishedVersion: 8 }, createdAt: at(4) }),
  ];
  const info = publishedInfoFor(messages, "out-1");
  assert.ok(info);
  assert.equal(info.publishedVersion, 3);
  assert.equal(info.forced, true);
  assert.deepEqual(info.rerun, { enqueued: 2, documents: 3, skippedNoPo: 1, skippedBelowCutoff: 0, skippedInFlight: 0, error: null });
  assert.equal(info.approvedChanged, 4);
  assert.equal(info.summary, "Published as layout version 3.");
  assert.deepEqual(info.sentBackStyleIds, ["style-9"]);
  assert.equal(publishedInfoFor(messages, "out-3"), null);
});

test("memoryIdOf: meta.memoryId, or meta.id; nothing else", () => {
  assert.equal(memoryIdOf({ memoryId: "mem-1" }), "mem-1");
  assert.equal(memoryIdOf({ id: "mem-2" }), "mem-2");
  assert.equal(memoryIdOf({ memoryId: "" }), null);
  assert.equal(memoryIdOf(null), null);
  assert.equal(memoryIdOf(["mem-1"]), null);
});
