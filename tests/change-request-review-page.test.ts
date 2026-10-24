// The /requests/[id] review screen's client half, rendered to static markup for
// every output status — a smoke test that each state renders what the admin
// (or the filing reviewer) needs, and nothing it shouldn't, without a browser
// or a database. Effects don't run in a static render, so no fetch is made;
// next/navigation and the polling hook are stubbed.
//
// Fixtures are synthetic. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageView, OutputView, RequestView, StepView } from "@/lib/change-requests/review-view";
import type { ImpactRow, ImpactSummary, OutputStatus } from "@/lib/change-requests/types";

before(() => {
  mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ refresh() {}, push() {}, replace() {} }) },
  });
  mock.module("@/lib/use-visible-poll", { namedExports: { useVisiblePoll: () => {} } });
});

const row = (styleId: string, over: Partial<ImpactRow> = {}): ImpactRow => ({
  styleId,
  styleLabel: `Style ${styleId}`,
  poNumber: "PO-0000",
  variantKey: "layout:bogus-layout",
  changed: true,
  reviewStatus: "PENDING_REVIEW",
  uploaded: false,
  emailed: false,
  inFlight: false,
  ...over,
});

const IMPACT: ImpactSummary = {
  rows: [row("s1"), row("s2", { reviewStatus: "APPROVED", emailed: true }), row("s3", { changed: false })],
  counts: {
    styles: 3,
    docs: 3,
    changed: 2,
    unchanged: 1,
    changedByStatus: { PENDING_REVIEW: 1, APPROVED: 1, REJECTED: 0, NONE: 0 },
    approvedChanged: 1,
    deliveredChanged: 1,
  },
};

function output(id: string, status: OutputStatus, over: Partial<OutputView> = {}): OutputView {
  return {
    id,
    position: 0,
    label: `Output ${id}`,
    variantKey: "layout:bogus-layout",
    layoutId: "bogus-layout",
    styleId: "s1",
    text: `Issue text for ${id}`,
    status,
    attachments: [{ id: `att-${id}`, fileName: "shot.png", mimeType: "image/png", byteSize: 10 }],
    rejectReason: null,
    publishedLabel: null,
    layoutName: "Polybag 50x60",
    layoutPinnedByAgent: false,
    currentRevisionId: null,
    draftCount: 0,
    firstTryApproved: null,
    awaitingToken: null,
    codeSpec: null,
    impact: null,
    revisions: [],
    published: null,
    ...over,
  };
}

const rev = (id: string, number: number, status: string) => ({
  id,
  number,
  status,
  authorKind: "AGENT",
  note: null,
  parentRevisionId: null,
  publishedVersion: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  createdLabel: "20 Oct 2026, 10:00",
});

function msg(id: string, outputId: string | null, over: Partial<MessageView>): MessageView {
  return {
    id,
    outputId,
    authorKind: "SYSTEM",
    author: "System",
    kind: "status",
    body: "",
    revisionId: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    createdLabel: "20 Oct 2026, 10:00",
    memory: null,
    ...over,
  };
}

function step(id: string, outputId: string, kind: string, summary: string, costUsd: number | null = null): StepView {
  return {
    id,
    outputId,
    kind,
    summary,
    model: costUsd != null ? "a-model" : null,
    inputTokens: costUsd != null ? 1200 : null,
    outputTokens: costUsd != null ? 300 : null,
    costUsd,
    createdAt: "2026-10-20T10:00:00.000Z",
    timeLabel: "10:00:00",
  };
}

function adminView(): RequestView {
  return {
    generatedAt: 1,
    admin: true,
    id: "req-1",
    ref: "R-0001",
    title: "Polybag sticker · PO-0000",
    status: "IN_REVIEW",
    source: "REQUESTER",
    poNumber: "PO-0000",
    message: "Pasted text",
    requester: "reviewer@example.com",
    requesterIsViewer: false,
    createdLabel: "20 Oct 2026, 10:00",
    generalAttachments: [],
    outputs: [
      output("review", "IN_REVIEW", {
        currentRevisionId: "rev-2",
        draftCount: 2,
        impact: IMPACT,
        revisions: [rev("rev-2", 2, "DRAFT"), rev("rev-1", 1, "SUPERSEDED")],
      }),
      output("new", "NEW"),
      output("working", "WORKING"),
      output("question", "IN_REVIEW"),
      output("info", "NEEDS_INFO"),
      output("code", "NEEDS_CODE", {
        awaitingToken: "packQty",
        codeSpec: { tokenKey: "packQty", label: "Pack quantity", rule: "Pieces per pack", board: "Orders", column: "Pack", cases: 2 },
      }),
      output("failed", "FAILED"),
      output("live", "PUBLISHED", {
        currentRevisionId: "rev-9",
        impact: IMPACT,
        firstTryApproved: true,
        publishedLabel: "21 Oct 2026, 09:00",
        published: {
          publishedVersion: 4,
          forced: false,
          rerun: { enqueued: 1, documents: 1, skippedNoPo: 0, skippedBelowCutoff: 0, skippedInFlight: 0, error: null },
          approvedChanged: 1,
          deliveredChanged: 1,
          impactError: null,
          summary: "Published as layout version 4. 1 changed document rerun on 1 style.",
          sentBackStyleIds: [],
        },
      }),
      output("rejected", "REJECTED", { rejectReason: "The old size was right" }),
      output("replaced", "IN_REVIEW", { currentRevisionId: "rev-5", revisions: [rev("rev-5", 5, "SUPERSEDED")] }),
    ],
    messages: [
      msg("m0", null, { body: "Request received" }),
      msg("m1", "review", { authorKind: "AGENT", author: "Assistant", kind: "message", body: "Added the quantity block", revisionId: "rev-2" }),
      msg("m2", "review", {
        authorKind: "AGENT",
        author: "Assistant",
        kind: "memory_suggestion",
        body: "Quantities in bold",
        memory: { id: "mem-1", state: "PROPOSED", text: "Quantities in bold for this customer", scope: "CUSTOMER" },
      }),
      msg("m3", "question", { authorKind: "AGENT", author: "Assistant", kind: "question", body: "Which size do you mean?" }),
      msg("m4", "info", { authorKind: "AGENT", author: "Assistant", kind: "question", body: "Is it per pack or per carton?" }),
      msg("m5", "failed", { body: "The agent used all 30 of its tool calls without finishing." }),
    ],
    steps: [
      step("s1", "review", "run_start", "Run started (new)"),
      step("s2", "review", "model_turn", "Turn 1 · get_layout", 0.0123),
      step("s3", "working", "run_start", "Run started (comment)"),
      step("s4", "working", "tool:get_layout", "Read the layout"),
    ],
  };
}

async function render(view: RequestView, outputId: string): Promise<string> {
  const { RequestReview } = await import("../src/app/(admin)/requests/[id]/request-review");
  return renderToStaticMarkup(createElement(RequestReview, { view, initialOutputId: outputId }));
}

test("in review with a draft: what they asked, drafts, proofs area, impact, diff, thread with memory card, approve bar, run log", async () => {
  const html = await render(adminView(), "review");
  for (const text of [
    "What they asked",
    "Issue text for review",
    "/api/admin/change-requests/req-1/attachments/att-review",
    "Draft 2 · current",
    "Draft 1 · superseded",
    "Added the quantity block",
    "Before and after",
    "Which documents change",
    "1 approved document changes",
    "already delivered to the supplier",
    "Layout changes",
    "Remember for next time?",
    "Keep",
    "Dismiss",
    "Approve Output review",
    "Reject…",
    "Polybag 50x60",
    "bogus-layout",
    "Run log · 2 steps · $0.01",
    "Ask for changes to this draft…",
  ]) {
    assert.ok(html.includes(text), `missing: ${text}`);
  }
  // Another output's question is not in this tab's thread.
  assert.equal(html.includes("Which size do you mean?"), false);
});

test("the output's layout shows by name and id in the header and by the approve button; agent pins are flagged", async () => {
  const view = adminView();
  const html = await render(view, "review");
  // Once in the output header, once next to Approve.
  assert.equal(html.split("Polybag 50x60").length - 1, 2);
  assert.equal(html.includes("pinned by the agent"), false);

  view.outputs[0] = { ...view.outputs[0], variantKey: null, layoutPinnedByAgent: true };
  const pinned = await render(view, "review");
  assert.equal(pinned.split("pinned by the agent").length - 1, 2);

  // The requester never sees layout ids.
  const requester = await render({ ...view, admin: false }, "review");
  assert.equal(requester.includes("bogus-layout"), false);
});

test("each status shows its own next step", async () => {
  const view = adminView();
  const cases: Array<[string, string[]]> = [
    ["new", ["The agent hasn&#x27;t started on this output", "Start the agent"]],
    ["working", ["The agent is working…", "Read the layout"]],
    ["question", ["The agent has a question", "Which size do you mean?", "Answer the question…"]],
    ["info", ["Waiting for the requester", "Is it per pack or per carton?"]],
    ["code", ["This change needs new code first", "{{packQty}}", "/requests/req-1/build-prompt?output=code", "Get build prompt"]],
    ["failed", ["The agent run failed", "tool calls without finishing", "Run again"]],
    [
      "live",
      [
        "Live as layout version 4",
        "Approved on the first draft",
        "Published as layout version 4.",
        "Approved documents that changed · 1",
        "Send approved documents back to review…",
        "Changed documents already delivered to the supplier · 1",
      ],
    ],
    ["rejected", ["Rejected — the layout stays as it is", "The old size was right"]],
    ["replaced", ["This draft was replaced by another publish"]],
  ];
  for (const [id, texts] of cases) {
    const html = await render(view, id);
    for (const text of texts) assert.ok(html.includes(text), `${id}: missing ${text}`);
    if (id !== "review") assert.equal(html.includes("Approve Output"), false, `${id}: no approve button`);
  }
});

test("requester view: their issue and the thread; an answer box only while the agent waits on them", async () => {
  const view: RequestView = {
    ...adminView(),
    admin: false,
    requester: "You",
    requesterIsViewer: true,
    steps: [],
    messages: adminView().messages.filter((m) => m.kind !== "memory_suggestion"),
  };
  view.outputs = view.outputs.map((o) => ({ ...o, revisions: [], impact: null, currentRevisionId: null, published: null }));

  const info = await render(view, "info");
  assert.ok(info.includes("We need an answer from you"));
  assert.ok(info.includes("Is it per pack or per carton?"));
  assert.ok(info.includes("Answer the question…"));
  for (const hidden of ["Run log", "Approve", "Reject…", "Which documents change", "Start the agent"]) {
    assert.equal(info.includes(hidden), false, `requester sees ${hidden}`);
  }

  const inReview = await render(view, "review");
  assert.ok(inReview.includes("With an admin"));
  assert.equal(inReview.includes("<textarea"), false, "no composer unless an answer is needed");

  const rejected = await render(view, "rejected");
  assert.ok(rejected.includes("Reason: The old size was right"));
});
