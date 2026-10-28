// The change-request job's orchestration: what it hands the loop, and what it
// does with each way a run can end. The loop is replaced by a scripted stand-in
// (its own behaviour is covered by src/lib/change-requests/agent/loop.test.ts);
// the store and the two Prisma delegates the job reads are in-memory fakes. The
// guarantees pinned here:
//
//   • finish with a draft made in THIS run → IN_REVIEW, that draft current,
//     draftCount + 1, the agent's summary in the thread, a stale impact gone;
//   • finish without such a draft (an answer, "no change needed") → IN_REVIEW
//     with the agent's words; the current draft, if any, stays current;
//   • only a broken run (budget, refusal, cut off, error, no key) is FAILED;
//   • a code handoff / question applied by its own tool is left alone, but a
//     draft made before it still counts and stays current;
//   • a run whose output left WORKING meanwhile is not applied;
//   • tool steps refresh the heartbeat, at most every 30 s;
//   • a run is claimed with one conditional write, only from a claimable
//     status, and a lock older than the stale threshold no longer blocks;
//   • stale WORKING outputs are failed by the sweep, fresh ones are not.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/generated/prisma/client";
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
        impact: null,
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
// Prisma's update semantics the job relies on: { increment } and DbNull.
function applyPatch(o: Row, patch: Row) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === Prisma.DbNull) o[k] = null;
    else if (v && typeof v === "object" && "increment" in (v as Row)) o[k] = (o[k] as number) + ((v as Row).increment as number);
    else o[k] = v;
  }
}

const setOutputStatus = mock.fn(async (id: string, status: string, patch: Row = {}) => {
  const o = outputs.get(id);
  if (!o) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
  o.status = status;
  applyPatch(o, patch);
  o.updatedAt = new Date();
  return { id, requestId: o.requestId };
});
const rollUpRequestStatus = mock.fn(async () => "WORKING");
let updateManyCalls: { where: Row; data: Row }[] = [];
const heartbeats = () => updateManyCalls.filter((c) => "updatedAt" in c.data);

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
  rollUpRequestStatus,
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
    // status: "X" or status: { in: [...] }, as the job writes them.
    updateMany: async (args: { where: Row; data: Row }) => {
      updateManyCalls.push(args);
      const o = outputs.get(args.where.id as string);
      const want = args.where.status;
      const matches =
        typeof want === "string" ? o?.status === want : ((want as { in?: unknown[] } | undefined)?.in ?? []).includes(o?.status);
      if (!o || !matches) return { count: 0 };
      applyPatch(o, args.data);
      return { count: 1 };
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
  updateManyCalls = [];
  setOutputStatus.mock.resetCalls();
  rollUpRequestStatus.mock.resetCalls();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CHANGE_REQUEST_MODEL;
  delete process.env.CHANGE_REQUEST_EFFORT;
});

afterEach(() => {
  mock.timers.reset();
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

test("finish without any draft (no change needed or possible) → IN_REVIEW with the agent's explanation, not FAILED", async () => {
  loopImpl = async () =>
    result({
      stopReason: "terminal",
      terminal: { name: "finish", input: { summary: "The value is wrong on Monday, not in the layout." }, result: { content: "ok" } },
    });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });

  assert.deepEqual(outcome, { status: "IN_REVIEW" });
  const out = outputs.get("out-1")!;
  assert.equal(out.status, "IN_REVIEW");
  assert.equal(out.currentRevisionId, null, "no draft is made current");
  assert.equal(out.draftCount, 0);
  assert.deepEqual(
    messages.map((m) => [m.authorKind, m.kind, m.body, m.revisionId]),
    [["AGENT", "message", "The value is wrong on Monday, not in the layout.", null]],
  );
});

test("a comment run that only answers keeps the current draft: IN_REVIEW, same draft, same count, the answer in the thread", async () => {
  outputs.get("out-1")!.currentRevisionId = "rev-old";
  outputs.get("out-1")!.draftCount = 1;
  outputs.get("out-1")!.impact = { counts: { changed: 3 } };
  messages.push(
    { outputId: "out-1", authorKind: "AGENT", kind: "message", body: "Here is a draft", revisionId: "rev-old" },
    { outputId: "out-1", authorKind: "USER", kind: "message", body: "Why 7 pt?", revisionId: null },
  );
  loopImpl = async () => result({ stopReason: "end_turn", finalText: "7 pt is the smallest size that fits the block." });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "comment", userId: "admin-1" });

  assert.deepEqual(outcome, { status: "IN_REVIEW", revisionId: "rev-old" });
  const out = outputs.get("out-1")!;
  assert.equal(out.status, "IN_REVIEW");
  assert.equal(out.currentRevisionId, "rev-old");
  assert.equal(out.draftCount, 1, "an answer is not a draft");
  assert.deepEqual(out.impact, { counts: { changed: 3 } }, "the draft's impact still belongs to it");
  const answer = messages.at(-1)!;
  assert.equal(answer.authorKind, "AGENT");
  assert.equal(answer.body, "7 pt is the smallest size that fits the block.");
  assert.equal(answer.revisionId, null, "the draft's own summary stays the one shown with it");
  // The prompt told the agent an answer is a valid way to finish.
  assert.match(firstText(loopCalls[0]), /only asks a question, answer it with finish/);
});

test("an empty closing turn without a draft still goes to review, with a system note", async () => {
  loopImpl = async () => result({ stopReason: "end_turn", finalText: "" });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: null });
  assert.equal(outcome.status, "IN_REVIEW");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].authorKind, "SYSTEM");
  assert.match(messages[0].body as string, /without a draft or an explanation/);
});

test("a new draft replaces the current one and drops the old draft's stored impact; the same draft keeps it", async () => {
  outputs.get("out-1")!.currentRevisionId = "rev-old";
  outputs.get("out-1")!.draftCount = 1;
  outputs.get("out-1")!.impact = { counts: { changed: 3 } };
  let made = "";
  loopImpl = async () => {
    made = addDraft();
    return result({ stopReason: "terminal", terminal: { name: "finish", input: { summary: "v2" }, result: { content: "ok" } } });
  };
  await job.runChangeRequestJob("out-1", { trigger: "comment", userId: "admin-1" });
  let out = outputs.get("out-1")!;
  assert.equal(out.currentRevisionId, made);
  assert.equal(out.draftCount, 2);
  assert.equal(out.impact, null, "an impact computed for rev-old must not show for the new draft");

  // propose_patch already pointed the output at the draft and impact_list
  // stored its impact: the job keeps that impact.
  reset();
  loopImpl = async () => {
    made = addDraft();
    outputs.get("out-1")!.currentRevisionId = made;
    outputs.get("out-1")!.impact = { counts: { changed: 1 } };
    return result({ stopReason: "terminal", terminal: { name: "finish", input: { summary: "v1" }, result: { content: "ok" } } });
  };
  await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  out = outputs.get("out-1")!;
  assert.equal(out.currentRevisionId, made);
  assert.deepEqual(out.impact, { counts: { changed: 1 } });
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

test("a draft made before a question or a code handoff counts (draftCount + 1) and stays current", async () => {
  for (const [name, status] of [
    ["ask_reviewer", "NEEDS_INFO"],
    ["declare_gap", "NEEDS_CODE"],
  ] as const) {
    reset();
    let made = "";
    loopImpl = async (opts) => {
      made = addDraft();
      outputs.get("out-1")!.currentRevisionId = made;
      await setOutputStatus(opts.ctx.outputId!, status);
      return result({ stopReason: "terminal", terminal: { name, input: {}, result: { content: "ok" } } });
    };
    const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
    assert.deepEqual(outcome, { status, revisionId: made }, name);
    const out = outputs.get("out-1")!;
    assert.equal(out.status, status, "the hand-off's status stands");
    assert.equal(out.draftCount, 1, name);
    assert.equal(out.currentRevisionId, made);
  }
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
  assert.doesNotMatch(text, /The admin replied/);
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

test("a comment run with no current draft says the admin replied, not that they commented on a draft", async () => {
  messages.push(
    { outputId: "out-1", authorKind: "AGENT", kind: "message", body: "No layout change is needed: Monday has the wrong value.", revisionId: null },
    { outputId: "out-1", authorKind: "USER", kind: "message", body: "It was fixed on Monday, check again.", revisionId: null },
  );
  loopImpl = async () => result({ stopReason: "max_calls" });
  await job.runChangeRequestJob("out-1", { trigger: "comment", userId: "admin-1" });
  const text = firstText(loopCalls[0]);
  assert.match(text, /The admin replied to you\. The thread so far:/);
  assert.doesNotMatch(text, /commented on your draft/);
  assert.doesNotMatch(text, /Revise this draft/);
  assert.match(text, /- You: No layout change is needed/);
  assert.match(text, /- Reviewer: It was fixed on Monday/);
});

test("a run on the cover is told it can only suggest, and finishing without a draft goes to review", async () => {
  Object.assign(outputs.get("out-1")!, { label: "Cover page (Prod Spec)", variantKey: "__cover__", layoutId: null });
  loopImpl = async () => result({ stopReason: "end_turn", finalText: "Change the cover block in Settings › Cover page to …" });
  const outcome = await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });

  const text = firstText(loopCalls[0]);
  assert.ok(text.includes(job.COVER_BRIEFING));
  assert.doesNotMatch(text, /layout id/);
  assert.equal(outcome.status, "IN_REVIEW");
  assert.equal(outputs.get("out-1")!.currentRevisionId, null);
  assert.ok(messages.some((m) => m.authorKind === "AGENT" && /Settings › Cover page/.test(m.body as string)));
});

test("a run on a layout output gets no cover briefing", async () => {
  loopImpl = async () => result({ stopReason: "max_calls" });
  await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  assert.ok(!firstText(loopCalls[0]).includes(job.COVER_BRIEFING));
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

// ── heartbeat ───────────────────────────────────────────────────────────────

test("tool steps refresh the heartbeat at most every 30 s; model turns always do", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  loopImpl = async (opts) => {
    await opts.ctx.log({ kind: "tool:get_layout", summary: "get_layout: ok" });
    await opts.ctx.log({ kind: "read", summary: "Layout" });
    await opts.ctx.log({ kind: "tool:list_tokens", summary: "list_tokens: ok" });
    assert.equal(heartbeats().length, 1, "three steps within 30 s → one write");
    mock.timers.tick(31_000);
    await opts.ctx.log({ kind: "tool:render_proof", summary: "render_proof: ok" });
    assert.equal(heartbeats().length, 2, "a step after 30 s beats again");
    await opts.onTurn?.({
      turn: 1,
      model: "claude-opus-5-5",
      stopReason: "tool_use",
      toolCalls: ["render_proof"],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      fallback: false,
    });
    assert.equal(heartbeats().length, 3, "a model turn always beats");
    return result({ stopReason: "max_calls" });
  };
  await job.runChangeRequestJob("out-1", { trigger: "new", userId: "admin-1" });
  for (const hb of heartbeats()) assert.deepEqual(hb.where, { id: "out-1", status: "WORKING" }, "only a WORKING output is touched");
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
  // One conditional write claims it, then the request rolls up.
  assert.deepEqual(updateManyCalls[0], {
    where: { id: "out-1", status: { in: ["NEW", "FAILED", "IN_REVIEW", "NEEDS_INFO", "NEEDS_CODE"] } },
    data: { status: "WORKING" },
  });
  assert.equal(setOutputStatus.mock.callCount(), 0);
  assert.deepEqual(rollUpRequestStatus.mock.calls[0].arguments, ["req-1"]);

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

test("startChangeRequestRun never claims an output a person has settled (approved, published, rejected)", async () => {
  loopImpl = async () => assert.fail("no run may start");
  for (const status of ["APPROVED", "PUBLISHED", "REJECTED"]) {
    outputs.get("out-1")!.status = status;
    const res = await job.startChangeRequestRun("out-1", { trigger: "comment", userId: "admin-1" });
    assert.equal(res.started, false, status);
    assert.match((res as { reason: string }).reason, new RegExp(`The output is ${status.toLowerCase()}`));
    assert.equal(outputs.get("out-1")!.status, status, "left as it was");
    assert.equal(job.isRunInProgress("out-1"), false);
  }
  assert.equal(rollUpRequestStatus.mock.callCount(), 0);
  // Every claimable status starts a run.
  for (const status of job.CLAIMABLE_STATUSES) {
    reset();
    outputs.get("out-1")!.status = status;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    loopImpl = async () => {
      await gate;
      return result({ stopReason: "max_calls" });
    };
    const res = await job.startChangeRequestRun("out-1", { trigger: "new", userId: "admin-1" });
    assert.deepEqual(res, { started: true }, status);
    release();
    for (let i = 0; i < 50 && job.isRunInProgress("out-1"); i++) await new Promise((r) => setTimeout(r, 5));
  }
});

test("a lock older than the stale threshold no longer blocks, and the hung run can't release the new run's lock", async () => {
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  outputs.get("out-1")!.status = "IN_REVIEW";
  const gates: (() => void)[] = [];
  loopImpl = async () => {
    await new Promise<void>((r) => gates.push(r));
    return result({ stopReason: "max_calls" });
  };
  assert.deepEqual(await job.startChangeRequestRun("out-1", { trigger: "comment", userId: "admin-1" }), { started: true });

  // 21 minutes later the sweep has failed the hung run's output.
  mock.timers.tick(21 * 60_000);
  outputs.get("out-1")!.status = "FAILED";
  assert.equal(job.isRunInProgress("out-1"), false, "a stale lock reads as no run");
  assert.deepEqual(await job.startChangeRequestRun("out-1", { trigger: "new", userId: "admin-1" }), { started: true });
  for (let i = 0; i < 50 && gates.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 2);

  // The hung run ends first: the new run still holds its lock, and the late
  // result (max_calls → FAILED) is not applied over it.
  gates[0]();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(job.isRunInProgress("out-1"), true);
  assert.equal(outputs.get("out-1")!.status, "WORKING");
  assert.ok(steps.some((st) => /a newer run took over/.test(st.summary as string)));
  assert.equal(
    (await job.startChangeRequestRun("out-1", { trigger: "new", userId: "admin-1" })).started,
    false,
    "a third start is still refused",
  );
  gates[1]();
  for (let i = 0; i < 50 && job.isRunInProgress("out-1"); i++) await new Promise((r) => setImmediate(r));
  assert.equal(job.isRunInProgress("out-1"), false);
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
