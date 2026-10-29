// =====================================================
// Change-request agent — the Anthropic client and its knobs.
//
// The agent uses the official SDK (design §9.2): tool use + vision + streaming
// are exactly what the SDK does well, and a hand-rolled fetch would have to
// re-implement stream accumulation and typed errors. The existing ✨ AI fix
// keeps its raw-fetch client (rejection-ai/anthropic.ts); the one thing shared
// is AiNotConfiguredError, so every AI feature reports a missing key the same
// way.
//
// Everything that varies per deploy comes from the environment, so trying a
// cheaper model or another effort level is a Railway variable, not a code
// change:
//   CHANGE_REQUEST_MODEL        default below
//   CHANGE_REQUEST_EFFORT       low | medium | high | xhigh | max (default high —
//                               the model's own default is lower, so it is always
//                               sent explicitly)
//   CHANGE_REQUEST_TASK_BUDGET  optional advisory token budget for a whole run
//                               (≥ 20000); unset = none
//
// The pure helpers here (cost, image blocks, env parsing) are what the job and
// the loop share; none of them touch the network.
// =====================================================

import Anthropic from "@anthropic-ai/sdk";
import { AiNotConfiguredError } from "@/lib/rejection-ai/anthropic";

export { AiNotConfiguredError };

const DEFAULT_MODEL = "claude-opus-5-5";

export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
const DEFAULT_EFFORT: AgentEffort = "high";

// Room for adaptive thinking AND the reply: thinking counts toward max_tokens,
// so a limit sized for a short answer cuts long agentic turns off. Streaming
// keeps a limit this large clear of HTTP timeouts.
export const AGENT_MAX_TOKENS = 64_000;

// Server-side refusal fallback: when the model's safety classifiers decline a
// turn (a false positive is possible on any workload), the API re-runs the same
// request on the fallback model Anthropic recommends for that refusal category,
// inside the same call. "default" is the scalar form and pairs with exactly this
// beta header; on a model without fallbacks the request simply runs alone.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const AGENT_FALLBACKS = "default" as const;

export const TASK_BUDGET_BETA = "task-budgets-2026-03-13";
const TASK_BUDGET_MIN = 20_000;

// One client per key. Constructing it never calls the network; a missing key
// throws the typed error the job turns into "AI is not configured".
let cached: { key: string; client: Anthropic } | null = null;

export function getAgentClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new AiNotConfiguredError();
  // The SDK's own OpenTelemetry spans are off: the loop records each call as
  // a Langfuse generation itself (src/lib/ai/tracing.ts), with our usage
  // types and cost, and both would otherwise reach Langfuse.
  if (!cached || cached.key !== apiKey) cached = { key: apiKey, client: new Anthropic({ apiKey, openTelemetry: false }) };
  return cached.client;
}

export function agentModel(): string {
  return process.env.CHANGE_REQUEST_MODEL?.trim() || DEFAULT_MODEL;
}

// An unknown value falls back to the default instead of failing every run on a
// typo in an environment variable.
export function agentEffort(): AgentEffort {
  const raw = process.env.CHANGE_REQUEST_EFFORT?.trim().toLowerCase();
  return (AGENT_EFFORTS as readonly string[]).includes(raw ?? "") ? (raw as AgentEffort) : DEFAULT_EFFORT;
}

// null = no task budget. Below the API minimum or not a number → none.
export function agentTaskBudget(): number | null {
  const raw = process.env.CHANGE_REQUEST_TASK_BUDGET?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= TASK_BUDGET_MIN ? n : null;
}

// ── Cost ─────────────────────────────────────────────────────────────────────
// USD per million tokens. Cache writes are the 5-minute TTL (1.25× input) the
// loop's automatic caching uses. Sonnet 5.5 is here so CHANGE_REQUEST_MODEL can
// try it with the cost still shown. The refusal-fallback targets are listed too
// (Opus 5 and Opus 4.8 for Opus 5.5, Sonnet 5 for Sonnet 5.5) so a turn served
// by the fallback is still priced. Haiku's long-prompt tier (over 100K tokens)
// is not modelled: the split call stays far below it.
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

// Token counts as the API reports them: inputTokens is the UNCACHED input;
// cache reads and writes are counted separately and priced separately.
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// From the SDK's usage object (null-safe: cache fields are null when unused).
export function tokenUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Required<TokenUsage> {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

// null for a model we have no price for — an honest "unknown" beats a wrong
// number in the cost signals.
export function costUsd(model: string, usage: TokenUsage): number | null {
  const p = PRICES[model.trim().toLowerCase()];
  if (!p) return null;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

// ── Vision ───────────────────────────────────────────────────────────────────
export const AGENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AgentImageType = (typeof AGENT_IMAGE_TYPES)[number];
// The API's per-image ceiling for base64 images. Attachments are downscaled in
// the browser before upload, so this only catches the odd outlier.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// "image/JPG; charset=…" → "image/jpeg"; anything the API can't read → null.
export function agentImageType(mime: string | null | undefined): AgentImageType | null {
  const t = (mime ?? "").split(";")[0].trim().toLowerCase();
  const norm = t === "image/jpg" ? "image/jpeg" : t;
  return (AGENT_IMAGE_TYPES as readonly string[]).includes(norm) ? (norm as AgentImageType) : null;
}

export function imageBlock(bytes: Uint8Array, mediaType: AgentImageType): Anthropic.Beta.BetaImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
  };
}
