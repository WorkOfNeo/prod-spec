// =====================================================
// Change-request agent — the tool-use loop.
//
// A manual loop rather than the SDK's beta tool runner, because the run has
// rules the runner doesn't know about: a hand-off tool (finish / declare_gap /
// ask_reviewer) ends the run the moment it succeeds, a hard budget of tool
// calls, a typed reason for every way a run can stop, and an audit row per
// tool call. The loop itself touches no database and gets its client injected,
// so it is tested end to end with a fake client (loop.test.ts); the job
// (job.ts) supplies the real client, the tools and the logging.
//
// Per turn: stream the request and take finalMessage() (long turns at high
// effort would otherwise risk HTTP timeouts), check stop_reason BEFORE reading
// content (a refusal or a max_tokens cut can leave a half-written tool call),
// then run every tool_use block of the turn and answer them ALL in ONE user
// message — splitting results across messages teaches the model to stop
// calling tools in parallel.
//
// Tool inputs stream eagerly (eager_input_streaming), so the API no longer
// validates them: every input is checked with the tool's zod schema here, and
// a failure goes back to the model as an is_error result it can correct.
//
// History is append-only — system prompt, tools and earlier turns are never
// edited — which keeps the prompt cache warm and the model's thinking blocks
// valid from one turn to the next.
// =====================================================

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { toolStepKind } from "../types";
import { TERMINAL_TOOLS, type AgentTool, type AgentToolName, type ToolContext, type ToolResult } from "./contract";
import {
  AGENT_FALLBACKS,
  AGENT_MAX_TOKENS,
  FALLBACK_BETA,
  TASK_BUDGET_BETA,
  costUsd as priceUsage,
  tokenUsage,
  type AgentEffort,
  type TokenUsage,
} from "./client";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;
type StreamParams = BetaMessageStreamParams;

// The slice of the SDK client the loop uses. The real Anthropic client fits it;
// tests pass a fake that replays canned messages.
export interface AgentLoopClient {
  beta: { messages: { stream(params: StreamParams): { finalMessage(): Promise<BetaMessage> } } };
}

export type AgentStopReason = "terminal" | "end_turn" | "max_calls" | "refusal" | "max_tokens" | "error";

export type AgentToolCall = { name: string; input: unknown; isError: boolean; durationMs: number };

export type AgentUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

// One model turn, handed to onTurn so the job can log a step with its cost.
export type AgentTurn = {
  turn: number; // 1-based
  // The model that served the turn — a refusal fallback can change it.
  model: string;
  stopReason: string | null;
  toolCalls: string[];
  usage: AgentUsage;
  costUsd: number | null;
  // A server-side refusal fallback served (part of) this turn.
  fallback: boolean;
};

export type AgentLoopResult = {
  stopReason: AgentStopReason;
  // The hand-off tool that ended the run (stopReason "terminal").
  terminal?: { name: AgentToolName; input: unknown; result: ToolResult };
  // The model's closing text (stopReason "end_turn").
  finalText?: string;
  // Plain reason for stopReason "error".
  error?: string;
  // stop_details.category for stopReason "refusal" (null = no named category).
  refusalCategory?: string | null;
  calls: AgentToolCall[];
  turns: number;
  usage: AgentUsage;
  // null when any turn ran on a model without a price.
  costUsd: number | null;
};

export type RunAgentLoopOptions = {
  client: AgentLoopClient;
  model: string;
  effort: AgentEffort;
  system: string;
  userContent: string | BetaContentBlockParam[];
  tools: AgentTool[];
  ctx: ToolContext;
  maxToolCalls?: number;
  // Advisory token budget for the whole run (beta); null/undefined = none.
  taskBudgetTokens?: number | null;
  onTurn?: (turn: AgentTurn) => void | Promise<void>;
};

// A stream that rejects without an API error is almost always a tool input the
// SDK could not parse at all (eager streaming moves that failure to the
// client). The failed turn was never appended, so re-issuing it is safe.
const MAX_CONSECUTIVE_STREAM_RETRIES = 2;
// pause_turn only happens with server tools (none here); bounded anyway.
const MAX_PAUSES = 3;
// From this many calls left, each tool-result message reminds the model to hand
// the request back rather than run out mid-investigation.
const LOW_BUDGET_WARNING = 3;
// Audit excerpts: enough to see what happened, small enough for a step row.
const EXCERPT_CHARS = 4000;

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const { client, model, effort, system, tools, ctx, onTurn } = opts;
  const maxToolCalls = opts.maxToolCalls ?? 30;
  const byName = new Map<string, AgentTool>(tools.map((t) => [t.name, t]));
  const toolDefs = toolDefinitions(tools);
  const budget = opts.taskBudgetTokens ?? null;

  const messages: BetaMessageParam[] = [{ role: "user", content: opts.userContent }];
  const calls: AgentToolCall[] = [];
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let cost: number | null = 0;
  let turns = 0;
  let streamRetries = 0;
  let pauses = 0;

  const done = (stopReason: AgentStopReason, extra: Partial<AgentLoopResult> = {}): AgentLoopResult => ({
    stopReason,
    ...extra,
    calls,
    turns,
    usage,
    costUsd: cost === null ? null : round6(cost),
  });

  for (;;) {
    const params: StreamParams = {
      model,
      max_tokens: AGENT_MAX_TOKENS,
      system,
      // A copy: the next turn appends to `messages`, and nothing the SDK (or a
      // test) keeps from this request should change under it.
      messages: [...messages],
      thinking: { type: "adaptive" },
      output_config: { effort, ...(budget ? { task_budget: { type: "tokens", total: budget } } : {}) },
      betas: budget ? [FALLBACK_BETA, TASK_BUDGET_BETA] : [FALLBACK_BETA],
      fallbacks: AGENT_FALLBACKS,
      // Automatic caching: the breakpoint moves to the newest block each turn,
      // so every turn re-reads the whole earlier conversation from cache.
      cache_control: { type: "ephemeral" },
      ...(toolDefs.length ? { tools: toolDefs, tool_choice: { type: "auto" as const } } : {}),
    };

    let message: BetaMessage;
    try {
      message = await client.beta.messages.stream(params).finalMessage();
      streamRetries = 0;
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) && streamRetries < MAX_CONSECUTIVE_STREAM_RETRIES) {
        streamRetries++;
        continue;
      }
      return done("error", { error: describeError(err) });
    }

    turns++;
    const turnUsage = tokenUsage(message.usage);
    const turnCost = priceUsage(message.model, turnUsage);
    usage.inputTokens += turnUsage.inputTokens;
    usage.outputTokens += turnUsage.outputTokens;
    usage.cacheReadTokens += turnUsage.cacheReadTokens;
    usage.cacheWriteTokens += turnUsage.cacheWriteTokens;
    cost = cost === null || turnCost === null ? null : cost + turnCost;

    const content = echoableContent(message.content);
    const toolUses = content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    await quietly(() =>
      onTurn?.({
        turn: turns,
        model: message.model,
        stopReason: message.stop_reason,
        toolCalls: toolUses.map((b) => b.name),
        usage: turnUsage,
        costUsd: turnCost,
        fallback: servedByFallback(message),
      }),
    );

    // Stop reasons first: never run the tools of a refused or truncated turn.
    switch (message.stop_reason) {
      case "refusal":
        return done("refusal", { refusalCategory: message.stop_details?.category ?? null });
      case "max_tokens":
        return done("max_tokens");
      case "pause_turn":
        if (++pauses > MAX_PAUSES) return done("error", { error: "The model kept pausing without finishing its turn" });
        messages.push({ role: "assistant", content: content as BetaContentBlockParam[] });
        continue;
      case "end_turn":
      case "stop_sequence":
        return done("end_turn", { finalText: textOf(content) });
      case "tool_use":
        if (toolUses.length > 0) break;
        return done("error", { error: "The model asked to use a tool but sent no tool call" });
      default:
        return done("error", { error: `The model stopped unexpectedly (${message.stop_reason ?? "no stop reason"})` });
    }

    messages.push({ role: "assistant", content: content as BetaContentBlockParam[] });

    // The call budget is strict: calls past it are never run. Hand-off tools
    // are admitted first, so a turn like [impact_list, finish] at 29 of 30
    // still hands the request back instead of ending as max_calls with the
    // work done. Within a turn, ordinary calls run in parallel; drafts
    // (propose_patch) then run one at a time in the model's order, because
    // each builds on the output's current draft and two at once would fork
    // it; hand-off tools run last, one at a time, so a hand-off sees every
    // draft the turn made and the first successful one ends the run.
    const runnable = admitWithinBudget(toolUses, Math.max(0, maxToolCalls - calls.length));
    const isTerminal = (name: string) => TERMINAL_TOOLS.has(name as AgentToolName);
    const isSerial = (name: string) => SERIAL_TOOLS.has(name as AgentToolName);
    const results = new Map<string, BetaToolResultBlockParam>();

    const plain = await Promise.all(
      runnable.filter((b) => !isTerminal(b.name) && !isSerial(b.name)).map((b) => executeTool(b, byName, ctx)),
    );
    for (const r of plain) {
      calls.push(r.call);
      results.set(r.block.tool_use_id, r.block);
    }
    for (const b of runnable.filter((x) => isSerial(x.name))) {
      const r = await executeTool(b, byName, ctx);
      calls.push(r.call);
      results.set(r.block.tool_use_id, r.block);
    }

    let terminal: AgentLoopResult["terminal"];
    for (const b of runnable.filter((x) => isTerminal(x.name))) {
      const r = await executeTool(b, byName, ctx);
      calls.push(r.call);
      results.set(r.block.tool_use_id, r.block);
      if (r.ok && r.result) {
        terminal = { name: b.name as AgentToolName, input: r.call.input, result: r.result };
        break;
      }
    }

    if (terminal) return done("terminal", { terminal });
    if (calls.length >= maxToolCalls) return done("max_calls");

    const reply: BetaContentBlockParam[] = toolUses.map(
      (b) => results.get(b.id) ?? { type: "tool_result", tool_use_id: b.id, is_error: true, content: "Not run" },
    );
    const left = maxToolCalls - calls.length;
    if (left <= LOW_BUDGET_WARNING) {
      reply.push({
        type: "text",
        text:
          `${left} tool call${left === 1 ? "" : "s"} left in this run. Hand the request back before they run out: ` +
          "finish with the draft you have, or ask_reviewer / declare_gap if you cannot.",
      });
    }
    messages.push({ role: "user", content: reply });
  }
}

// ── Budget + ordering ────────────────────────────────────────────────────────

// Tools that run one at a time, in order, within a turn (see the loop).
const SERIAL_TOOLS: ReadonlySet<AgentToolName> = new Set(["propose_patch"]);

// The calls of one turn that fit in what is left of the budget: hand-off
// tools first, then the rest in the model's order. Returned in the model's
// order; the loop decides the execution order by kind.
export function admitWithinBudget<T extends { name: string }>(toolUses: readonly T[], left: number): T[] {
  if (left <= 0) return [];
  if (toolUses.length <= left) return [...toolUses];
  const isTerminal = (b: T) => TERMINAL_TOOLS.has(b.name as AgentToolName);
  const admitted = new Set<T>([...toolUses.filter(isTerminal), ...toolUses.filter((b) => !isTerminal(b))].slice(0, left));
  return toolUses.filter((b) => admitted.has(b));
}

// ── Tool definitions ─────────────────────────────────────────────────────────

// AgentTool → Messages API tool. The schema is the zod INPUT side (fields with
// defaults stay optional for the model); the `$schema` dialect marker is not
// part of a tool schema.
export function toolDefinitions(tools: readonly AgentTool[]): BetaTool[] {
  return tools.map((tool) => {
    const json = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete json.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...json, type: "object" } as BetaTool["input_schema"],
      eager_input_streaming: true,
    };
  });
}

// ── One tool call ────────────────────────────────────────────────────────────

type Executed = {
  call: AgentToolCall;
  block: BetaToolResultBlockParam;
  // Ran and did not report an error.
  ok: boolean;
  result?: ToolResult;
};

async function executeTool(
  block: BetaToolUseBlock,
  byName: Map<string, AgentTool>,
  ctx: ToolContext,
): Promise<Executed> {
  const started = Date.now();
  const tool = byName.get(block.name);
  let input: unknown = block.input;
  let result: ToolResult | undefined;
  let content: BetaToolResultBlockParam["content"];
  let isError = true;

  if (!tool) {
    content = JSON.stringify({ error: `Unknown tool "${block.name}"`, available: [...byName.keys()] });
  } else {
    const parsed = tool.input.safeParse(block.input);
    if (!parsed.success) {
      content = JSON.stringify({
        error: `Invalid input for ${tool.name}`,
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    } else {
      input = parsed.data;
      try {
        result = await tool.run(parsed.data, ctx);
        isError = result.isError === true;
        content = resultContent(result);
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const durationMs = Date.now() - started;
  const text = typeof content === "string" ? content : textOfParams(content ?? []);
  await quietly(() =>
    ctx.log({
      kind: toolStepKind(block.name),
      summary: isError
        ? `${block.name}: error · ${text.replace(/\s+/g, " ").slice(0, 300)}`
        : `${block.name}: ok · ${durationMs} ms`,
      detail: {
        toolUseId: block.id,
        input: excerpt(block.input),
        isError,
        durationMs,
        result: text.slice(0, EXCERPT_CHARS),
        ...(result?.images?.length ? { images: result.images.length } : {}),
      },
    }),
  );

  return {
    call: { name: block.name, input, isError, durationMs },
    block: { type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) },
    ok: !isError && !!result,
    result,
  };
}

// ToolResult → tool_result content: text (objects as JSON), then each image
// with its caption, inside the tool_result so the model sees the proof as the
// answer to the call that rendered it.
function resultContent(result: ToolResult): BetaToolResultBlockParam["content"] {
  const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  const text = raw && raw.length > 0 ? raw : "(no output)";
  if (!result.images?.length) return text;
  const blocks: Exclude<BetaToolResultBlockParam["content"], string | undefined> = [{ type: "text", text }];
  for (const img of result.images) {
    if (img.caption) blocks.push({ type: "text", text: img.caption });
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  }
  return blocks;
}

// ── Response handling ────────────────────────────────────────────────────────

// What may be echoed back (and acted on) after a server-side refusal fallback.
// Content before the last `fallback` marker is the declined model's partial
// output: only its text may be echoed — its thinking and any half-made tool
// call must be dropped, never run. Everything after the marker is the fallback
// model's own turn. Without a fallback this is the content as sent.
export function echoableContent(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") boundary = i;
  });
  if (boundary < 0) return [...content];
  return [...content.slice(0, boundary).filter((b) => b.type === "text"), ...content.slice(boundary + 1)];
}

function servedByFallback(message: BetaMessage): boolean {
  return (
    message.content.some((b) => b.type === "fallback") ||
    (message.usage.iterations ?? []).some((it) => it.type === "fallback_message")
  );
}

function textOf(content: readonly BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

function textOfParams(blocks: readonly { type: string }[]): string {
  return blocks
    .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function describeError(err: unknown): string {
  // The SDK's message already leads with the HTTP status ("429 …").
  if (err instanceof Anthropic.APIError) return `Claude API error: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function excerpt(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "";
  } catch {
    s = String(value);
  }
  return s.length > EXCERPT_CHARS ? `${s.slice(0, EXCERPT_CHARS)}…` : s;
}

// The audit trail must never break the run it records: a failed log write is
// reported on the console and the run goes on.
async function quietly(fn: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error("[change-requests] agent log write failed:", err);
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export type { TokenUsage };
