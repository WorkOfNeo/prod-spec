// The change-request job's orchestration: what it hands the loop, and what it
// does with each way a run can end. The loop is replaced by a scripted stand-in
// (its own behaviour is covered by src/lib/change-requests/agent/loop.test.ts);
// the store and the two Prisma delegates the job reads are in-memory fakes. The
// guarantees pinned here:
//
//   • finish with a draft made in THIS run → IN_REVIEW, that draft current,
//     draftCount + 1, the agent's summary in the thread;
//   • finish without such a draft → FAILED with a plain system message;
//   • a missing API key → FAILED "AI is not configured", the loop never runs;
//   • a code handoff / question applied by its own tool is left alone;
//   • a run whose output left WORKING meanwhile is not applied;
//   • stale WORKING outputs are failed by the sweep, fresh ones are not.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyLayoutOps } from "@/lib/output-layouts/ops";
import { defaultLayoutDef } from "@/lib/output-layouts/schema";
import { DEFAULT_CHANGE_REQUEST_AGENT_PROMPT } from "@/lib/change-requests/agent/prompt";
import type { AgentLoopResult, RunAgentLoopOptions } from "@/lib/change-requests/agent/loop";

type Row = Record<string, unknown>;

// ── In-memory state ─────────────────────────────────────────────────────────
let outputs: Map<string, Row>;
let request: Row;
let revisions: Row[];
let messages: Row[];
let steps: Row[];
let attachments: Row[];
let seq = 0;

function reset() {
  seq = 0;
  request = {
    id: "req-1",
    number: 7,
    title: "Polybag sticker shows no quantity",
    status: "WORKING",
    message: "The quantity is missing on the polybag sticker.",
    source: "ADMIN",
    createdById: "admin-1",
    customerId: null,
    poNumber: "PO-0000",
    styleId: "style-1",
  };
  outputs = new Map([
    [
      "out-1",
      {
        id: "out-1",
        requestId: "req-1",
        position: 0,
        label: "Solid polybag sticker",
        variantKey: "layout:lay-1",
        layoutId: "lay-1",
        styleId: "style-1",
        text: "Add the pieces-per-polybag quantity.",
        status: "WORKING",
        currentRevisionId: null,
        draftCount: 0,
        awaitingToken: null,
        updatedAt: new Date(),
      },
    ],
    [
      "out-2",
      {
        id: "out-2",
        requestId: "req-1",
        position: 1,
        label: "Carton label",
        text: "Wrong font.",
        status: "NEW",
        currentRevisionId: null,
        draftCount: 0,
        updatedAt: new Date(),
      },
    ],
  ]);
  // A draft from an EARLIER run of the same output: never mistaken for this one.
  revisions = [
    {
      id: "rev-old",
      layoutId: "lay-1",
      number: 1,
      status: "DRAFT",
      changeRequestOutputId: "out-1",
      createdAt: new Date(Date.now() - 3_600_000),
      definition: defaultLayoutDef(),
      baseDefinition: defaultLayoutDef(),
    },
  ];
  messages = [];
  steps = [];
  attachments = [];
}

function addDraft(id = `rev-${++seq + 1}`): string {
  revisions.push({
    id,
    layoutId: "lay-1",
    number: revisions.length + 1,
    status: "DRAFT",
    changeRequestOutputId: "out-1",
    createdAt: new Date(),
    definition: defaultLayoutDef(),
    baseDefinition: defaultLayoutDef(),
  });
  return id;
}

// ── Fakes ───────────────────────────────────────────────────────────────────
const setOutputStatus = mock.fn(async (id: string, status: string, patch: Row = {}) => {
  const o = outputs.get(id);
  if (!o) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
  o.status = status;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && "increment" in (v as Row)) o[k] = (o[k] as number) + ((v as Row).increment as number);
    else o[k] = v;
  }
  o.updatedAt = new Date();
  return { id, requestId: o.requestId };
});

const store = {
  getOutputWithRequest: async (id: string) => {
    const o = outputs.get(id);
    return o ? { ...o, request } : null;
  },
  getRequestDetail: async (id: string) =>
    id === request.id
      ? { ...request, outputs: [...outputs.values()].map((o) => ({ ...o })), attachments: [], messages: [...messages], steps: [...steps] }
      : null,
  getAttachmentImages: async () => attachments,
  setOutputStatus,
  appendMessage: async (m: Row) => {
    const row = { id: `msg-${messages.length + 1}`, createdAt: new Date(), kind: "message", revisionId: null, ...m };
    messages.push(row);
    return row;
  },
  logStep: async (s: Row) => {
    steps.push(s);
    return s;
  },
};

const fakeDb = {
  outputLayoutRevision: {
    findUnique: async (args: { where: { id: string } }) => revisions.find((r) => r.id === args.where.id) ?? null,
    findMany: async (args: { where: Row }) =>
      revisions
        .filter(
          (r) =>
            r.changeRequestOutputId === args.where.changeRequestOutputId &&
            (args.where.status === undefined || r.status === args.where.status),
        )
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((r) => ({ id: r.id })),
  },
  changeRequestOutput: {
    findMany: async (args: { where: { status: string; updatedAt: { lt: Date } } }) =>
      [...outputs.values()]
        .filter((o) => o.status === args.where.status && (o.updatedAt as Date) < args.where.updatedAt.lt)
        .map((o) => ({ id: o.id, requestId: o.requestId })),
    updateMany: async (args: { where: Row; data: Row }) => {
      const o = outputs.get(args.where.id as string);
      if (o && o.status === args.where.status) {
        Object.assign(o, args.data);
        return { count: 1 };
      }
      return { count: 0 };
    },
  },
};

// The loop stand-in. Each test scripts what the "agent" does during the run.
let loopImpl: (opts: RunAgentLoopOptions) => Promise<AgentLoopResult>;
const loopCalls: RunAgentLoopOptions[] = [];

function result(partial: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    stopReason: "end_turn",
    calls: [],
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.0001,
    ...partial,
  };
}

let job: typeof import("@/lib/change-requests/agent/job");

before(async () => {
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/change-requests/store", { namedExports: store });
  mock.module("@/lib/prompts/system-prompts", {
    namedExports: { getSystemPromptContent: async () => DEFAULT_CHANGE_REQUEST_AGENT_PROMPT },
  });
  mock.module("@/lib/change-requests/agent/tools", { namedExports: { AGENT_TOOLS: [] } });
  mock.module("@/lib/change-requests/agent/loop", {
    namedExports: {
      runAgentLoop: async (opts: RunAgentLoopOptions) => {
        loopCalls.push(opts);
        return loopImpl(opts);
      },
    },
  });
  job = await import("@/lib/change-requests/agent/job");
});

beforeEach(() => {
  reset();
  loopCalls.length = 0;
  setOutputStatus.mock.resetCalls();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CHANGE_REQUEST_MODEL;
  delete process.env.CHANGE_REQUEST_EFFORT;
});

const firstText = (opts: RunAgentLoopOptions) => {
  const c = opts.userContent;
  return typeof c === "string" ? c : ((c[0] as { text: string }).text ?? "");
};

// ── finish ──────────────────────────────────────────────────────────────────

test("finish with a draft made in this run → IN_REVIEW, that draft current, the summary in the thread", async () => {
  let made = "";
  loopImpl = async (opts) => {
    made = addDraft();
    await opts.ctx.log({ kind: "tool:propose_patch", summary: "propose_patch: ok · 12 ms" });
    await opts.onTurn?.({
      turn: 1,
      model: "claude-opus-5-5",
      stopReason: "tool_use",
      toolCalls: ["propose_patch", "finish"],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 },
      costUsd: 0.0016,
      fallback: false,
    });
    return result({
      stopReason: "terminal",
      terminal: { name: "finish", input: { summary: "Added the quantity under the barcode." }, result: { content: "ok" } },
      calls: [{ name: "propose_patch", input: {}, isError: false, durationMs: 12 }],
    });
  };

  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });

  assert.deepEqual(outcome, { status: "IN_REVIEW", revisionId: made });
  const out = outputs.get("out-1")!;
  assert.equal(out.status, "IN_REVIEW");
  assert.equal(out.currentRevisionId, made, "the earlier run's draft is not picked");
  assert.equal(out.draftCount, 1);
  const agentMsg = messages.find((m) => m.authorKind === "AGENT");
  assert.equal(agentMsg?.body, "Added the quantity under the barcode.");
  assert.equal(agentMsg?.revisionId, made);
  assert.equal(messages.length, 1);

  // What the loop was given.
  const opts = loopCalls[0];
  assert.equal(opts.model, "claude-opus-5-5");
  assert.equal(opts.effort, "high");
  assert.equal(opts.maxToolCalls, 30);
  assert.deepEqual(opts.tools, []);
  assert.equal(opts.system, DEFAULT_CHANGE_REQUEST_AGENT_PROMPT);
  assert.equal(opts.ctx.requestId, "req-1");
  assert.equal(opts.ctx.outputId, "out-1");
  assert.equal(opts.ctx.userId, "admin-1");
  const text = firstText(opts);
  assert.match(text, /R-0007: Polybag sticker shows no quantity/);
  assert.match(text, /The quantity is missing on the polybag sticker\./);
  assert.match(text, /ONE output: "Solid polybag sticker"/);
  assert.match(text, /Add the pieces-per-polybag quantity\./);
  assert.match(text, /layout id lay-1/);
  assert.match(text, /leave them alone: "Carton label"/);

  // Steps: start, the tool call, the model turn with its cost, the end.
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ["run_start", "tool:propose_patch", "model_turn", "run_end"]);
  const turn = steps.find((s) => s.kind === "model_turn")!;
  assert.equal(turn.model, "claude-opus-5-5");
  assert.equal(turn.inputTokens, 1000);
  assert.equal(turn.outputTokens, 50);
  assert.equal(turn.costUsd, 0.0016);
  const end = steps.find((s) => s.kind === "run_end")!;
  assert.equal(end.costUsd, undefined, "totals are not double-counted in the cost columns");
});

test("finish without a draft from this run → FAILED with a system message (the agent's words kept)", async () => {
  loopImpl = async () =>
    result({
      stopReason: "terminal",
      terminal: { name: "finish", input: { summary: "The value is wrong on Monday, not in the layout." }, result: { content: "ok" } },
    });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });

  assert.equal(outcome.status, "FAILED");
  assert.equal(outputs.get("out-1")!.status, "FAILED");
  assert.equal(outputs.get("out-1")!.currentRevisionId, null);
  assert.deepEqual(
    messages.map((m) => [m.authorKind, m.body]),
    [
      ["AGENT", "The value is wrong on Monday, not in the layout."],
      ["SYSTEM", "The agent finished without a draft"],
    ],
  );
});

test("a closing text without a hand-off tool counts as finish", async () => {
  let made = "";
  loopImpl = async () => {
    made = addDraft();
    return result({ stopReason: "end_turn", finalText: "Draft ready: quantity added." });
  };
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: null });
  assert.equal(outcome.status, "IN_REVIEW");
  assert.equal(outputs.get("out-1")!.currentRevisionId, made);
  assert.equal(messages[0].body, "Draft ready: quantity added.");
});

// ── failures ────────────────────────────────────────────────────────────────

test("no API key → FAILED 'AI is not configured', and the loop never runs", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  loopImpl = async () => assert.fail("the loop must not run without a key");
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  assert.deepEqual(outcome, { status: "FAILED", reason: "AI is not configured (ANTHROPIC_API_KEY)" });
  assert.equal(outputs.get("out-1")!.status, "FAILED");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].authorKind, "SYSTEM");
  assert.equal(messages[0].body, "AI is not configured (ANTHROPIC_API_KEY)");
  assert.equal(loopCalls.length, 0);
});

test("max calls, refusal, max_tokens and errors → FAILED with a plain reason", async () => {
  const cases: [Partial<AgentLoopResult>, RegExp][] = [
    [{ stopReason: "max_calls" }, /used all 30 of its tool calls/],
    [{ stopReason: "refusal", refusalCategory: "cyber" }, /declined to work on this request \(safety refusal: cyber\)/],
    [{ stopReason: "max_tokens" }, /cut off at its output limit/],
    [{ stopReason: "error", error: "Claude API error: 529 overloaded" }, /The agent run failed: Claude API error: 529 overloaded/],
  ];
  for (const [partial, re] of cases) {
    reset();
    loopImpl = async () => result(partial);
    const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
    assert.equal(outcome.status, "FAILED", partial.stopReason);
    assert.equal(outputs.get("out-1")!.status, "FAILED");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].authorKind, "SYSTEM");
    assert.match(messages[0].body as string, re);
  }
});

test("a code handoff or a question applied by its own tool is left alone", async () => {
  loopImpl = async (opts) => {
    // What ask_reviewer does: post the question, move the output to NEEDS_INFO.
    await store.appendMessage({ requestId: "req-1", outputId: "out-1", authorKind: "AGENT", kind: "question", body: "Which size?" });
    await setOutputStatus(opts.ctx.outputId!, "NEEDS_INFO");
    return result({
      stopReason: "terminal",
      terminal: { name: "ask_reviewer", input: { question: "Which size?" }, result: { content: "asked" } },
    });
  };
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  assert.deepEqual(outcome, { status: "NEEDS_INFO" });
  assert.equal(outputs.get("out-1")!.status, "NEEDS_INFO");
  assert.equal(messages.length, 1, "the job posts nothing extra");
});

test("a hand-off that left the output WORKING is failed instead of hanging until the sweep", async () => {
  loopImpl = async () =>
    result({ stopReason: "terminal", terminal: { name: "declare_gap", input: {}, result: { content: "ok" } } });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  assert.equal(outcome.status, "FAILED");
  assert.match(messages[0].body as string, /hand-off \(declare_gap\) did not update the output/);
});

test("a run whose output left WORKING meanwhile (e.g. failed by the sweep) is not applied", async () => {
  loopImpl = async () => {
    addDraft();
    outputs.get("out-1")!.status = "FAILED";
    return result({ stopReason: "terminal", terminal: { name: "finish", input: { summary: "done" }, result: { content: "ok" } } });
  };
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  assert.deepEqual(outcome, { status: "FAILED", discarded: true });
  assert.equal(outputs.get("out-1")!.status, "FAILED");
  assert.equal(messages.length, 0);
});

// ── what a revision run sees ────────────────────────────────────────────────

test("a comment run gets the thread since the last draft, a summary of the current draft and the screenshots", async () => {
  const drafted = applyLayoutOps(defaultLayoutDef(), [
    { op: "add_block", page: 0, block: { id: "b-qty", rect: { col: 1, row: 1, colSpan: 10, rowSpan: 2 }, lines: ["PCS"] } },
  ]);
  assert.equal(drafted.rejected.length, 0);
  revisions[0].definition = drafted.def;
  outputs.get("out-1")!.currentRevisionId = "rev-old";
  outputs.get("out-1")!.draftCount = 1;
  messages.push(
    { outputId: "out-1", authorKind: "USER", kind: "message", body: "Before the draft", revisionId: null },
    { outputId: "out-1", authorKind: "AGENT", kind: "message", body: "Here is a draft", revisionId: "rev-old" },
    { outputId: "out-2", authorKind: "USER", kind: "message", body: "About the carton", revisionId: null },
    { outputId: "out-1", authorKind: "USER", kind: "message", body: "Make it bold", revisionId: null },
  );
  attachments = [
    { id: "a1", outputId: "out-1", fileName: "screenshot-1.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
    { id: "a2", outputId: null, fileName: "notes.pdf", mimeType: "application/pdf", data: new Uint8Array([4]) },
  ];
  loopImpl = async () => result({ stopReason: "max_calls" });
  await job.runChangeRequestJob("out-1", { trigger: "comment", userId: "admin-1" });

  const content = loopCalls[0].userContent as { type: string; text?: string; source?: { data: string } }[];
  const text = content[0].text!;
  assert.match(text, /commented on your draft/);
  assert.match(text, /- Reviewer: Make it bold/);
  assert.doesNotMatch(text, /Before the draft/, "only what came after the last draft");
  assert.doesNotMatch(text, /About the carton/, "not another output's thread");
  assert.match(text, /current draft is revision #1/);
  assert.match(text, /- Added a block at col 1, row 1 \(10×2\): PCS \(block b-qty\)/);
  assert.match(text, /Revise this draft/);
  // Screenshots after the text, each captioned with its file name.
  assert.deepEqual(
    content.slice(1).map((b) => b.type),
    ["text", "image", "text"],
  );
  assert.equal(content[1].text, "Screenshot 1: screenshot-1.png");
  assert.equal(content[2].source?.data, "AQID");
  assert.match(content[3].text!, /notes\.pdf \(application\/pdf\) is not an image/);
  assert.ok(steps.some((s) => s.kind === "read_images" && /1 screenshot sent/.test(s.summary as string)));
});

test("threadSinceLastDraft: the whole thread when there is no draft yet", () => {
  const thread = job.threadSinceLastDraft(
    [
      { outputId: "out-1", authorKind: "AGENT", kind: "question", body: "Which size?", revisionId: null },
      { outputId: null, authorKind: "USER", kind: "message", body: "Size M", revisionId: null },
    ] as never,
    "out-1",
  );
  assert.equal(thread.length, 2);
});

// ── start + lock ────────────────────────────────────────────────────────────

test("startChangeRequestRun claims the output, returns at once, and refuses a second run", async () => {
  outputs.get("out-1")!.status = "IN_REVIEW";
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  loopImpl = async () => {
    await gate;
    return result({ stopReason: "max_calls" });
  };

  const first = await job.startChangeRequestRun("out-1", { trigger: "comment", userId: "admin-1" });
  assert.deepEqual(first, { started: true });
  assert.equal(outputs.get("out-1")!.status, "WORKING");
  assert.equal(job.isRunInProgress("out-1"), true);

  const second = await job.startChangeRequestRun("out-1", { trigger: "comment", userId: "admin-1" });
  assert.equal(second.started, false);

  release();
  for (let i = 0; i < 50 && job.isRunInProgress("out-1"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.isRunInProgress("out-1"), false, "the lock is released when the run ends");
  assert.equal(outputs.get("out-1")!.status, "FAILED");
});

test("startChangeRequestRun refuses an output already WORKING (another process) or unknown", async () => {
  outputs.get("out-1")!.status = "WORKING";
  const res = await job.startChangeRequestRun("out-1", { trigger: "new", userId: "admin-1" });
  assert.deepEqual(res, { started: false, reason: "The agent is already working on this output" });
  assert.equal(setOutputStatus.mock.callCount(), 0);
  assert.equal(job.isRunInProgress("out-1"), false);

  const missing = await job.startChangeRequestRun("nope", { trigger: "new", userId: "admin-1" });
  assert.deepEqual(missing, { started: false, reason: "Output not found" });
});

// ── stale sweep ─────────────────────────────────────────────────────────────

test("failStaleRuns fails WORKING outputs with no sign of life, and only those", async () => {
  outputs.get("out-1")!.updatedAt = new Date(Date.now() - 25 * 60_000);
  outputs.get("out-2")!.status = "WORKING";
  outputs.get("out-2")!.updatedAt = new Date(Date.now() - 60_000);

  const res = await job.failStaleRuns();
  assert.deepEqual(res, { failed: ["out-1"] });
  assert.equal(outputs.get("out-1")!.status, "FAILED");
  assert.equal(outputs.get("out-2")!.status, "WORKING");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].authorKind, "SYSTEM");
  assert.equal(messages[0].outputId, "out-1");
  assert.match(messages[0].body as string, /no progress for 20 minutes/);

  // Idempotent: nothing left to fail.
  assert.deepEqual(await job.failStaleRuns(), { failed: [] });
});
