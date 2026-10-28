// =====================================================
// Langfuse tracing for the AI features — the shared pieces.
//
// Exporting is set up once, at server start (src/instrumentation.ts), and only
// when the Langfuse keys are set. Without them @langfuse/tracing runs on
// OpenTelemetry's no-op tracer, so an observation costs nothing; what is worth
// skipping is BUILDING trace payloads (screenshots turned into data URIs), so
// callers build those only when langfuseConfigured().
//
// The shape follows Langfuse's guide to a good trace
// (https://langfuse.com/docs/observability/best-practices):
//   • one trace per unit of work: an agent run, one AI fix, one answer;
//   • a `generation` per model call, with the model, token usage under
//     Anthropic's usage types (so cache reads and writes are priced) and, where
//     we know it, our own cost;
//   • a `tool` per tool call, a sibling of the generation that asked for it;
//   • messages in the OpenAI chat shape Langfuse renders as a conversation,
//     tool calls as cards, images as data URIs it uploads as media.
// =====================================================

export function langfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

// ── Usage ────────────────────────────────────────────────────────────────────

// Anthropic reports the UNCACHED input; cache reads and writes are separate
// usage types, each priced on its own. These are the keys Langfuse's model
// prices use for them.
export function anthropicUsageDetails(u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): Record<string, number> {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    cache_read_input_tokens: u.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
  };
}

// ── Messages (Anthropic → the chat shape Langfuse renders) ───────────────────

// Loose on purpose: request params, response blocks and the raw-fetch JSON
// all fit, without tying this module to one SDK's types. Fields are read
// through `field`, which checks nothing but saves a cast at every use.
type Block = { readonly type: string };
type MessageLike = { readonly role: string; readonly content?: string | readonly Block[] };

function field(b: Block, key: string): unknown {
  return (b as unknown as Record<string, unknown>)[key];
}

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string | ChatPart[] }
  | {
      role: "assistant";
      content: string;
      // The turn's thinking, so a trace shows why the model chose its next step.
      thinking?: string;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string | ChatPart[] };

// An Anthropic base64 image source as a data URI: Langfuse finds data URIs in
// a trace's payloads and uploads them as media, so the screenshot the model
// read shows in the trace instead of a wall of base64.
function dataUri(source: unknown): string | null {
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown } | null;
  if (!s || s.type !== "base64" || typeof s.media_type !== "string" || typeof s.data !== "string") return null;
  return `data:${s.media_type};base64,${s.data}`;
}

function textAndImages(content: string | readonly Block[] | undefined): string | ChatPart[] {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: ChatPart[] = [];
  for (const b of content) {
    const text = field(b, "text");
    if (b.type === "text" && typeof text === "string") parts.push({ type: "text", text });
    else if (b.type === "image") {
      const url = dataUri(field(b, "source"));
      parts.push(url ? { type: "image_url", image_url: { url } } : { type: "text", text: "[image]" });
    }
  }
  return parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts;
}

// One assistant turn: its text, its thinking, and the tools it called.
export function assistantMessage(content: readonly Block[]): ChatMessage {
  const text = content
    .filter((b) => b.type === "text" && typeof field(b, "text") === "string")
    .map((b) => field(b, "text") as string);
  const thinking = content
    .map((b) =>
      b.type === "thinking" && typeof field(b, "thinking") === "string"
        ? (field(b, "thinking") as string)
        : b.type === "redacted_thinking"
          ? "[redacted thinking]"
          : null,
    )
    .filter((t): t is string => t !== null && t.trim() !== "");
  const toolCalls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(field(b, "id")),
      type: "function" as const,
      function: { name: String(field(b, "name")), arguments: JSON.stringify(field(b, "input") ?? {}) },
    }));
  return {
    role: "assistant",
    content: text.join("\n\n"),
    ...(thinking.length ? { thinking: thinking.join("\n\n") } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

// The whole conversation a model call saw: the system prompt, then each
// message. A user message's tool results become `tool` messages that answer
// the assistant's tool_calls by id, so the conversation reads in order.
export function chatMessages(system: string | null, messages: readonly MessageLike[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.content === undefined) continue;
    if (m.role === "assistant") {
      out.push(typeof m.content === "string" ? { role: "assistant", content: m.content } : assistantMessage(m.content));
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role === "system" ? "system" : "user", content: m.content });
      continue;
    }
    const rest: Block[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: String(field(b, "tool_use_id")),
          content: textAndImages(field(b, "content") as string | readonly Block[] | undefined),
        });
      } else rest.push(b);
    }
    if (rest.length) out.push({ role: "user", content: textAndImages(rest) });
  }
  return out;
}

// A tool's answer as the model got it: text, then any images (proofs) inline.
export function toolResultContent(content: string | readonly Block[] | undefined): string | ChatPart[] {
  return textAndImages(content);
}
