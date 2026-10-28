// Langfuse tracing for the AI features: the message shape Langfuse renders
// (pure), and the observation tree an agent run actually emits — captured with
// an in-memory OpenTelemetry exporter, so the test checks the spans Langfuse
// would receive (types, nesting, model, usage, cost, payloads) without a
// Langfuse server. The loop runs on a scripted fake client; nothing touches
// the network. Fixtures are synthetic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { trace, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { startActiveObservation } from "@langfuse/tracing";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicUsageDetails, assistantMessage, chatMessages } from "./tracing";
import type { AgentTool, ToolContext } from "@/lib/change-requests/agent/contract";
import { runAgentLoop, type AgentLoopClient } from "@/lib/change-requests/agent/loop";

const PNG = "iVBORw0KGgo=";

// ── The chat shape (pure) ───────────────────────────────────────────────────

test("chatMessages: system first; screenshots as data URIs; tool results answer their call by id", () => {
  // Bound first: the helpers take any block shape, which a literal passed
  // inline would fail TypeScript's excess-property check against.
  const conversation = [
    {
      role: "user",
      content: [
        { type: "text", text: "Fix the label" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_layout", input: { layoutId: "l1" } }] },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [
            { type: "text", text: '{"ok":true}' },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          ],
        },
        { type: "text", text: "2 tool calls left" },
      ],
    },
  ];
  const out = chatMessages("Be brief.", conversation);
  assert.deepEqual(out, [
    { role: "system", content: "Be brief." },
    {
      role: "user",
      content: [
        { type: "text", text: "Fix the label" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tu_1", type: "function", function: { name: "get_layout", arguments: '{"layoutId":"l1"}' } }],
    },
    {
      role: "tool",
      tool_call_id: "tu_1",
      content: [
        { type: "text", text: '{"ok":true}' },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
    { role: "user", content: "2 tool calls left" },
  ]);
});

test("assistantMessage: text, the turn's thinking and its tool calls", () => {
  const turn = [
    { type: "thinking", thinking: "The size line is missing." },
    { type: "text", text: "Adding it." },
    { type: "redacted_thinking", data: "…" },
    { type: "tool_use", id: "tu_2", name: "propose_patch", input: { ops: [] } },
  ];
  assert.deepEqual(
    assistantMessage(turn),
    {
      role: "assistant",
      content: "Adding it.",
      thinking: "The size line is missing.\n\n[redacted thinking]",
      tool_calls: [{ id: "tu_2", type: "function", function: { name: "propose_patch", arguments: '{"ops":[]}' } }],
    },
  );
});

test("usage: Anthropic's usage types, so Langfuse prices cache reads and writes", () => {
  assert.deepEqual(anthropicUsageDetails({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }), {
    input: 10,
    output: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 0,
  });
});

// ── The observation tree of an agent run ────────────────────────────────────

const exporter = new InMemorySpanExporter();
const env = { ...process.env };

before(() => {
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});

after(() => {
  trace.disable();
  context.disable();
  process.env = env;
});

type Msg = Anthropic.Beta.BetaMessage;
function msg(content: unknown[], stopReason: string): Msg {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  } as unknown as Msg;
}

function fakeClient(script: Msg[]): AgentLoopClient {
  let i = 0;
  return { beta: { messages: { stream: () => ({ finalMessage: async () => script[i++] }) } } };
}

const attr = (s: ReadableSpan, key: string) => s.attributes[`langfuse.observation.${key}`];
const json = (s: ReadableSpan, key: string) => JSON.parse(String(attr(s, key)));

test("an agent run: one agent root; a generation per turn and a tool per call, siblings under it", async () => {
  exporter.reset();
  const getLayout: AgentTool = {
    name: "get_layout",
    description: "test",
    input: z.object({ layoutId: z.string() }),
    run: async () => ({ content: { name: "Polybag" } }),
  };
  const finish: AgentTool = {
    name: "finish",
    description: "test",
    input: z.object({ summary: z.string() }),
    run: async () => ({ content: { ok: true } }),
  };
  const ctx: ToolContext = { requestId: "req-1", outputId: "out-1", userId: "admin-1", log: async () => {} };

  await startActiveObservation(
    "handle-change-request",
    async () => {
      await runAgentLoop({
        client: fakeClient([
          msg(
            [
              { type: "thinking", thinking: "Read the layout first.", signature: "s" },
              { type: "tool_use", id: "tu_1", name: "get_layout", input: { layoutId: "l1" } },
            ],
            "tool_use",
          ),
          msg([{ type: "tool_use", id: "tu_2", name: "finish", input: { summary: "Nothing to change." } }], "tool_use"),
        ]),
        model: "claude-opus-5-5",
        effort: "high",
        system: "You handle change requests.",
        userContent: [
          { type: "text", text: "The quantity is missing." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ],
        tools: [getLayout, finish],
        ctx,
      });
    },
    { asType: "agent" },
  );

  const spans = exporter.getFinishedSpans();
  const root = spans.find((s) => s.name === "handle-change-request")!;
  assert.equal(attr(root, "type"), "agent");
  const children = spans.filter((s) => s.parentSpanContext?.spanId === root.spanContext().spanId);
  assert.deepEqual(
    children.map((s) => [s.name, attr(s, "type")]),
    [
      ["decide-next-step", "generation"],
      ["get_layout", "tool"],
      ["decide-next-step", "generation"],
      ["finish", "tool"],
    ],
    "turns and tool calls interleave as siblings under the run",
  );

  const [first] = children;
  assert.equal(attr(first, "model.name"), "claude-opus-5-5");
  assert.deepEqual(json(first, "model.parameters"), { effort: "high", max_tokens: 64000 });
  assert.deepEqual(json(first, "usage_details"), {
    input: 100,
    output: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
  });
  assert.ok(json(first, "cost_details").total > 0, "our own price, since a new model may be unknown to Langfuse");
  const input = json(first, "input");
  assert.equal(input[0].role, "system");
  assert.equal(input[1].content[1].image_url.url, `data:image/png;base64,${PNG}`, "the screenshot, as media");
  const output = json(first, "output");
  assert.equal(output.thinking, "Read the layout first.");
  assert.equal(output.tool_calls[0].function.name, "get_layout");

  const tool = children[1];
  assert.deepEqual(json(tool, "input"), { layoutId: "l1" });
  // The tool's answer as the model got it (a JSON string, shown as JSON).
  assert.equal(attr(tool, "output"), '{"name":"Polybag"}');

  // The second turn saw the first turn and its tool result.
  const second = json(children[2], "input");
  assert.deepEqual(
    second.map((m: { role: string }) => m.role),
    ["system", "user", "assistant", "tool"],
  );
});

test("a failing tool is an ERROR observation with the reason", async () => {
  exporter.reset();
  const broken: AgentTool = {
    name: "get_layout",
    description: "test",
    input: z.object({ layoutId: z.string() }),
    run: async () => ({ isError: true, content: { error: "Layout l1 not found." } }),
  };
  const ctx: ToolContext = { requestId: "req-1", outputId: "out-1", userId: null, log: async () => {} };
  await runAgentLoop({
    client: fakeClient([
      msg([{ type: "tool_use", id: "tu_1", name: "get_layout", input: { layoutId: "l1" } }], "tool_use"),
      msg([{ type: "text", text: "Done.", citations: null }], "end_turn"),
    ]),
    model: "claude-opus-5-5",
    effort: "high",
    system: "s",
    userContent: "u",
    tools: [broken],
    ctx,
  });
  const tool = exporter.getFinishedSpans().find((s) => s.name === "get_layout")!;
  assert.equal(attr(tool, "level"), "ERROR");
  assert.match(String(attr(tool, "status_message")), /Layout l1 not found/);
});
