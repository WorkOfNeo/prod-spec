// The agent's tool-use loop, driven end to end by a fake client that replays
// scripted model turns. No network, no database: the loop gets its client and
// tools injected, which is exactly what makes these guarantees testable —
// results of one turn go back in ONE message, bad input and thrown errors come
// back as is_error results, a hand-off tool ends the run, the call budget is
// strict, and a refused or truncated turn never runs its tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk/core/error";
import { z } from "zod";
import type { AgentTool, AgentToolName, ToolContext, ToolResult } from "./contract";
import {
  admitWithinBudget,
  echoableContent,
  runAgentLoop,
  toolDefinitions,
  type AgentLoopClient,
  type AgentTurn,
} from "./loop";

type Params = Parameters<AgentLoopClient["beta"]["messages"]["stream"]>[0];
type Msg = Anthropic.Beta.BetaMessage;
type Step = Msg | Error | ((params: Params) => Msg);

function fakeClient(script: Step[]) {
  const requests: Params[] = [];
  let i = 0;
  const client: AgentLoopClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const step = script[i++];
          return {
            finalMessage: async () => {
              if (!step) throw new Anthropic.InternalServerError(500, undefined, "script exhausted", new Headers());
              if (step instanceof Error) throw step;
              return typeof step === "function" ? step(params) : step;
            },
          };
        },
      },
    },
  };
  return { client, requests };
}

function msg(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): Msg {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      fallback_credit: null,
      output_tokens_details: null,
    },
    ...extra,
  } as unknown as Msg;
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t, citations: null });

function tool(
  name: AgentToolName,
  run: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
  input: z.ZodType = z.object({ id: z.string() }),
): AgentTool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    description: `${name} for tests`,
    input,
    calls,
    run: async (i) => {
      calls.push(i);
      return run(i as Record<string, unknown>);
    },
  };
}

function ctx() {
  const logs: { kind: string; summary: string; detail?: Record<string, unknown> }[] = [];
  const c: ToolContext = {
    requestId: "req-1",
    outputId: "out-1",
    userId: "admin-1",
    log: async (s) => {
      logs.push(s);
    },
  };
  return { ctx: c, logs };
}

const base = { model: "claude-opus-5-5", effort: "high" as const, system: "You fix labels.", userContent: "Fix it." };

// The tool_result blocks of the user message sent on request `n`.
function resultsIn(p: Params) {
  const last = p.messages[p.messages.length - 1];
  assert.equal(last.role, "user");
  return (last.content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]).filter(
    (b) => b.type === "tool_result",
  );
}

test("a single tool call: validated input, one result back, closing text is the summary", async () => {
  const getLayout = tool("get_layout", () => ({ content: { blocks: 3 } }));
  const { client, requests } = fakeClient([
    msg([use("t1", "get_layout", { id: "lay-1" })], "tool_use"),
    msg([text("Looked at it; nothing to change.")], "end_turn"),
  ]);
  const { ctx: c, logs } = ctx();
  const res = await runAgentLoop({ ...base, client, tools: [getLayout], ctx: c });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(res.finalText, "Looked at it; nothing to change.");
  assert.deepEqual(getLayout.calls, [{ id: "lay-1" }]);
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].name, "get_layout");
  assert.equal(res.calls[0].isError, false);

  assert.equal(requests.length, 2);
  const results = resultsIn(requests[1]);
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, "t1");
  assert.equal(results[0].content, JSON.stringify({ blocks: 3 }));
  assert.equal(results[0].is_error, undefined);
  // The assistant turn is echoed back unchanged before the results.
  assert.equal(requests[1].messages[1].role, "assistant");

  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "tool:get_layout");
  assert.match(logs[0].summary, /^get_layout: ok/);

  // 2 turns × (100 in × $4 + 50 out × $20 + 1000 cache reads × $0.20) / 1M
  assert.deepEqual(res.usage, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0 });
  assert.equal(res.costUsd, 0.0032);
  assert.equal(res.turns, 2);
});

test("the request: adaptive thinking, explicit effort, refusal fallback, eager tool schemas, no sampling knobs", async () => {
  const getLayout = tool("get_layout", () => ({ content: "ok" }), z.object({ id: z.string(), page: z.number().default(0) }));
  const { client, requests } = fakeClient([msg([text("done")], "end_turn")]);
  await runAgentLoop({ ...base, client, tools: [getLayout], ctx: ctx().ctx });

  const p = requests[0] as Params & Record<string, unknown>;
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.deepEqual(p.output_config, { effort: "high" });
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.tool_choice, { type: "auto" });
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(p.system, "You fix labels.");
  assert.ok(p.max_tokens >= 32_000);
  for (const k of ["temperature", "top_p", "top_k"]) assert.equal(k in p, false, `${k} must not be sent`);

  const [def] = p.tools as Anthropic.Beta.BetaTool[];
  assert.equal(def.name, "get_layout");
  assert.equal(def.eager_input_streaming, true);
  assert.equal(def.input_schema.type, "object");
  assert.equal("$schema" in def.input_schema, false);
  // Input side of the schema: a field with a default is optional for the model.
  assert.deepEqual(def.input_schema.required, ["id"]);
});

test("a task budget, when configured, rides along with its beta header", async () => {
  const { client, requests } = fakeClient([msg([text("done")], "end_turn")]);
  await runAgentLoop({ ...base, client, tools: [], ctx: ctx().ctx, taskBudgetTokens: 50_000 });
  const p = requests[0] as Params & Record<string, unknown>;
  assert.deepEqual(p.output_config, { effort: "high", task_budget: { type: "tokens", total: 50_000 } });
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01", "task-budgets-2026-03-13"]);
  assert.equal("tools" in p, false, "no tools → no tools/tool_choice fields");
});

test("parallel calls in one turn run together and come back in ONE message, in the model's order", async () => {
  const events: string[] = [];
  const slow = tool("get_layout", async () => {
    events.push("layout:start");
    await new Promise((r) => setTimeout(r, 20));
    events.push("layout:end");
    return { content: "layout" };
  });
  const fast = tool("list_tokens", async () => {
    events.push("tokens:start");
    events.push("tokens:end");
    return { content: "tokens" };
  });
  const { client, requests } = fakeClient([
    msg([use("a", "get_layout", { id: "x" }), use("b", "list_tokens", { id: "y" })], "tool_use"),
    msg([text("ok")], "end_turn"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [slow, fast], ctx: ctx().ctx });

  assert.equal(res.stopReason, "end_turn");
  assert.ok(events.indexOf("tokens:start") < events.indexOf("layout:end"), "the second call did not wait for the first");
  const results = resultsIn(requests[1]);
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ["a", "b"],
  );
  assert.deepEqual(
    res.calls.map((c) => c.name),
    ["get_layout", "list_tokens"],
  );
  // Exactly one user message carries both results.
  assert.equal(requests[1].messages.length, 3);
});

test("invalid input never reaches the tool: an is_error result lists the issues", async () => {
  const getLayout = tool("get_layout", () => ({ content: "never" }));
  const { client, requests } = fakeClient([
    msg([use("t1", "get_layout", { id: 42 })], "tool_use"),
    msg([text("sorry")], "end_turn"),
  ]);
  const { ctx: c, logs } = ctx();
  const res = await runAgentLoop({ ...base, client, tools: [getLayout], ctx: c });

  assert.equal(getLayout.calls.length, 0);
  const [r] = resultsIn(requests[1]);
  assert.equal(r.is_error, true);
  const body = JSON.parse(r.content as string);
  assert.match(body.error, /Invalid input for get_layout/);
  assert.equal(body.issues[0].path, "id");
  assert.equal(res.calls[0].isError, true);
  assert.match(logs[0].summary, /^get_layout: error/);
});

test("a tool that throws becomes an is_error result, and the run goes on", async () => {
  const boom = tool("get_layout", () => {
    throw new Error("layout not found");
  });
  const { client, requests } = fakeClient([
    msg([use("t1", "get_layout", { id: "nope" })], "tool_use"),
    msg([text("could not find it")], "end_turn"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [boom], ctx: ctx().ctx });
  const [r] = resultsIn(requests[1]);
  assert.equal(r.is_error, true);
  assert.deepEqual(JSON.parse(r.content as string), { error: "layout not found" });
  assert.equal(res.stopReason, "end_turn");
});

test("an unknown tool name is answered with an error, not a crash", async () => {
  const { client, requests } = fakeClient([
    msg([use("t1", "find_layouts", { id: "x" })], "tool_use"),
    msg([text("ok")], "end_turn"),
  ]);
  await runAgentLoop({ ...base, client, tools: [tool("get_layout", () => ({ content: "" }))], ctx: ctx().ctx });
  const [r] = resultsIn(requests[1]);
  assert.equal(r.is_error, true);
  assert.match(JSON.parse(r.content as string).error, /Unknown tool "find_layouts"/);
});

test("images a tool returns go back inside its tool_result, each after its caption", async () => {
  const proof = tool("render_proof", () => ({
    content: { rendered: 1 },
    images: [{ mediaType: "image/png", base64: "iVBORw0KGgo=", caption: "after · STYLE-1 · doc 1" }],
  }));
  const { client, requests } = fakeClient([
    msg([use("p1", "render_proof", { id: "rev-1" })], "tool_use"),
    msg([text("looks right")], "end_turn"),
  ]);
  await runAgentLoop({ ...base, client, tools: [proof], ctx: ctx().ctx });
  const [r] = resultsIn(requests[1]);
  assert.deepEqual(r.content, [
    { type: "text", text: JSON.stringify({ rendered: 1 }) },
    { type: "text", text: "after · STYLE-1 · doc 1" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ]);
});

test("a successful hand-off tool ends the run; no further request is made", async () => {
  const finish = tool("finish", () => ({ content: "handed over" }), z.object({ summary: z.string() }));
  const { client, requests } = fakeClient([msg([use("f1", "finish", { summary: "Moved the quantity." })], "tool_use")]);
  const res = await runAgentLoop({ ...base, client, tools: [finish], ctx: ctx().ctx });
  assert.equal(res.stopReason, "terminal");
  assert.equal(res.terminal?.name, "finish");
  assert.deepEqual(res.terminal?.input, { summary: "Moved the quantity." });
  assert.equal(res.terminal?.result.content, "handed over");
  assert.equal(requests.length, 1);
});

test("a hand-off tool that reports an error does not end the run", async () => {
  let attempt = 0;
  const finish = tool(
    "finish",
    () => (++attempt === 1 ? { content: "no draft yet", isError: true } : { content: "ok" }),
    z.object({ summary: z.string() }),
  );
  const { client, requests } = fakeClient([
    msg([use("f1", "finish", { summary: "first" })], "tool_use"),
    msg([use("f2", "finish", { summary: "second" })], "tool_use"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [finish], ctx: ctx().ctx });
  assert.equal(res.stopReason, "terminal");
  assert.deepEqual(res.terminal?.input, { summary: "second" });
  assert.equal(resultsIn(requests[1])[0].is_error, true);
});

test("in one turn, hand-off tools run after the other calls, so they see the turn's draft", async () => {
  const order: string[] = [];
  const patch = tool("propose_patch", async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("propose_patch");
    return { content: "draft rev-9" };
  });
  const finish = tool(
    "finish",
    () => {
      order.push("finish");
      return { content: "ok" };
    },
    z.object({ summary: z.string() }),
  );
  const { client } = fakeClient([
    msg([use("f", "finish", { summary: "done" }), use("p", "propose_patch", { id: "lay-1" })], "tool_use"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [patch, finish], ctx: ctx().ctx });
  assert.deepEqual(order, ["propose_patch", "finish"]);
  assert.equal(res.stopReason, "terminal");
});

test("the call budget is strict: calls past it never run, and the run stops as max_calls", async () => {
  const getLayout = tool("get_layout", () => ({ content: "again" }));
  const { client, requests } = fakeClient([
    msg([use("1", "get_layout", { id: "a" })], "tool_use"),
    msg([use("2", "get_layout", { id: "b" }), use("3", "get_layout", { id: "c" }), use("4", "get_layout", { id: "d" })], "tool_use"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [getLayout], ctx: ctx().ctx, maxToolCalls: 3 });
  assert.equal(res.stopReason, "max_calls");
  assert.equal(res.calls.length, 3);
  assert.deepEqual(getLayout.calls, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  // Close to the limit the model is told how many calls are left.
  const reminder = (requests[1].messages[2].content as { type: string; text?: string }[]).find((b) => b.type === "text");
  assert.match(reminder?.text ?? "", /^2 tool calls left/);
});

test("at the budget's edge a hand-off is admitted first: [impact_list, finish] at 29 of 30 still finishes", async () => {
  const getLayout = tool("get_layout", () => ({ content: "again" }));
  const impact = tool("impact_list", () => ({ content: "12 change" }));
  const finish = tool("finish", () => ({ content: "handed over" }), z.object({ summary: z.string() }));
  const { client } = fakeClient([
    msg([use("1", "get_layout", { id: "a" }), use("2", "get_layout", { id: "b" })], "tool_use"),
    msg([use("3", "impact_list", { id: "rev" }), use("4", "finish", { summary: "Done." })], "tool_use"),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [getLayout, impact, finish], ctx: ctx().ctx, maxToolCalls: 3 });
  assert.equal(res.stopReason, "terminal");
  assert.equal(res.terminal?.name, "finish");
  assert.equal(impact.calls.length, 0, "the ordinary call past the budget never ran");
  assert.equal(res.calls.length, 3);
});

test("admitWithinBudget: everything when it fits, hand-offs first when it doesn't, in the model's order", () => {
  const t = (name: string) => ({ name });
  const turn = [t("get_layout"), t("impact_list"), t("ask_reviewer"), t("finish")];
  assert.deepEqual(admitWithinBudget(turn, 4), turn);
  assert.deepEqual(
    admitWithinBudget(turn, 3).map((b) => b.name),
    ["get_layout", "ask_reviewer", "finish"],
  );
  assert.deepEqual(
    admitWithinBudget(turn, 1).map((b) => b.name),
    ["ask_reviewer"],
  );
  assert.deepEqual(admitWithinBudget(turn, 0), []);
});

test("propose_patch calls of one turn run one at a time, in the model's order", async () => {
  const events: string[] = [];
  let active = 0;
  const patch = tool("propose_patch", async (input) => {
    active++;
    events.push(`start:${input.id}:${active}`);
    await new Promise((r) => setTimeout(r, input.id === "first" ? 20 : 1));
    events.push(`end:${input.id}`);
    active--;
    return { content: `draft for ${input.id}` };
  });
  const { client, requests } = fakeClient([
    msg([use("p1", "propose_patch", { id: "first" }), use("p2", "propose_patch", { id: "second" })], "tool_use"),
    msg([text("ok")], "end_turn"),
  ]);
  await runAgentLoop({ ...base, client, tools: [patch], ctx: ctx().ctx });
  assert.deepEqual(events, ["start:first:1", "end:first", "start:second:1", "end:second"]);
  assert.deepEqual(
    resultsIn(requests[1]).map((r) => r.tool_use_id),
    ["p1", "p2"],
  );
});

test("a refusal stops the run before any of its tool calls run", async () => {
  const getLayout = tool("get_layout", () => ({ content: "never" }));
  const { client } = fakeClient([
    msg([use("t1", "get_layout", { id: "a" })], "refusal", {
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    }),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [getLayout], ctx: ctx().ctx });
  assert.equal(res.stopReason, "refusal");
  assert.equal(res.refusalCategory, "cyber");
  assert.equal(getLayout.calls.length, 0);
});

test("a turn cut off at max_tokens never runs its (possibly truncated) tool call", async () => {
  const getLayout = tool("get_layout", () => ({ content: "never" }));
  const { client } = fakeClient([msg([use("t1", "get_layout", { id: "a" })], "max_tokens")]);
  const res = await runAgentLoop({ ...base, client, tools: [getLayout], ctx: ctx().ctx });
  assert.equal(res.stopReason, "max_tokens");
  assert.equal(getLayout.calls.length, 0);
});

test("an API error stops the run as error with the API's message", async () => {
  const { client, requests } = fakeClient([
    new Anthropic.RateLimitError(429, { message: "slow down" }, undefined, new Headers()),
  ]);
  const res = await runAgentLoop({ ...base, client, tools: [], ctx: ctx().ctx });
  assert.equal(res.stopReason, "error");
  assert.match(res.error ?? "", /429 slow down/);
  assert.equal(requests.length, 1, "API errors are not retried by the loop (the SDK already retried)");
});

test("an unparseable streamed tool input is re-issued, a bounded number of times", async () => {
  const parseError = () => new AnthropicError("Unable to parse tool parameter JSON from model.");
  const { client, requests } = fakeClient([parseError(), msg([text("fine now")], "end_turn")]);
  const res = await runAgentLoop({ ...base, client, tools: [], ctx: ctx().ctx });
  assert.equal(res.stopReason, "end_turn");
  assert.equal(requests.length, 2);

  const again = fakeClient([parseError(), parseError(), parseError(), msg([text("too late")], "end_turn")]);
  const res2 = await runAgentLoop({ ...base, client: again.client, tools: [], ctx: ctx().ctx });
  assert.equal(res2.stopReason, "error");
  assert.equal(again.requests.length, 3);
});

test("after a refusal fallback only the fallback model's tool calls run; the declined partial is not echoed", async () => {
  const getLayout = tool("get_layout", () => ({ content: "ok" }));
  const content = [
    { type: "thinking", thinking: "", signature: "sig" },
    text("Partial before the switch."),
    use("declined", "get_layout", { id: "half" }),
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
    use("served", "get_layout", { id: "whole" }),
  ];
  const { client, requests } = fakeClient([
    msg(content, "tool_use", { model: "claude-opus-4-8" }),
    msg([text("ok")], "end_turn"),
  ]);
  const turns: AgentTurn[] = [];
  await runAgentLoop({ ...base, client, tools: [getLayout], ctx: ctx().ctx, onTurn: (t) => void turns.push(t) });

  assert.deepEqual(getLayout.calls, [{ id: "whole" }]);
  const echoed = requests[1].messages[1].content as { type: string; id?: string }[];
  assert.deepEqual(
    echoed.map((b) => b.type),
    ["text", "tool_use"],
  );
  assert.equal(echoed[1].id, "served");
  assert.equal(turns[0].fallback, true);
  assert.equal(turns[0].model, "claude-opus-4-8");
  // Priced at the serving model's rates.
  assert.equal(turns[0].costUsd, (100 * 5 + 50 * 25 + 1000 * 0.5) / 1e6);
});

test("echoableContent leaves a turn without a fallback untouched", () => {
  const content = [text("a"), use("x", "get_layout", { id: "1" })] as unknown as Anthropic.Beta.BetaContentBlock[];
  assert.deepEqual(echoableContent(content), content);
});

test("onTurn sees every turn, including the one that ends the run; a failing log never breaks it", async () => {
  const turns: AgentTurn[] = [];
  const getLayout = tool("get_layout", () => ({ content: "x" }));
  const { client } = fakeClient([
    msg([use("1", "get_layout", { id: "a" })], "tool_use"),
    msg([text("bye")], "end_turn"),
  ]);
  const c: ToolContext = { ...ctx().ctx, log: async () => Promise.reject(new Error("db down")) };
  const res = await runAgentLoop({
    ...base,
    client,
    tools: [getLayout],
    ctx: c,
    onTurn: (t) => {
      turns.push(t);
      throw new Error("logging failed");
    },
  });
  assert.equal(res.stopReason, "end_turn");
  assert.deepEqual(
    turns.map((t) => [t.turn, t.stopReason, t.toolCalls]),
    [
      [1, "tool_use", ["get_layout"]],
      [2, "end_turn", []],
    ],
  );
  assert.equal(turns[0].costUsd, 0.0016);
});

test("toolDefinitions turns zod schemas into object JSON schemas", () => {
  const defs = toolDefinitions([
    tool("propose_patch", () => ({ content: "" }), z.object({ ops: z.array(z.object({ op: z.string() })), note: z.string().optional() })),
  ]);
  assert.equal(defs[0].input_schema.type, "object");
  assert.deepEqual(defs[0].input_schema.required, ["ops"]);
  assert.ok((defs[0].input_schema.properties as Record<string, unknown>).note);
});
