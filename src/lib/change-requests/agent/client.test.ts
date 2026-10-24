import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AiNotConfiguredError } from "@/lib/rejection-ai/anthropic";
import {
  agentEffort,
  agentImageType,
  agentModel,
  agentTaskBudget,
  costUsd,
  getAgentClient,
  imageBlock,
  tokenUsage,
} from "./client";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "CHANGE_REQUEST_MODEL", "CHANGE_REQUEST_EFFORT", "CHANGE_REQUEST_TASK_BUDGET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("no API key → the shared AiNotConfiguredError (the job shows 'AI is not configured')", () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.throws(() => getAgentClient(), AiNotConfiguredError);
  process.env.ANTHROPIC_API_KEY = "   ";
  assert.throws(() => getAgentClient(), AiNotConfiguredError);
});

test("with a key the client is built once and reused (no network involved)", () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const a = getAgentClient();
  assert.equal(getAgentClient(), a);
  process.env.ANTHROPIC_API_KEY = "other-key";
  assert.notEqual(getAgentClient(), a);
});

test("model and effort come from the environment, with safe defaults", () => {
  delete process.env.CHANGE_REQUEST_MODEL;
  delete process.env.CHANGE_REQUEST_EFFORT;
  assert.equal(agentModel(), "claude-opus-5-5");
  assert.equal(agentEffort(), "high");
  process.env.CHANGE_REQUEST_MODEL = "claude-haiku-5-5";
  process.env.CHANGE_REQUEST_EFFORT = "XHIGH";
  assert.equal(agentModel(), "claude-haiku-5-5");
  assert.equal(agentEffort(), "xhigh");
  process.env.CHANGE_REQUEST_EFFORT = "turbo";
  assert.equal(agentEffort(), "high", "a typo falls back instead of failing every run");
});

test("a task budget only when it is a whole number at or above the API minimum", () => {
  delete process.env.CHANGE_REQUEST_TASK_BUDGET;
  assert.equal(agentTaskBudget(), null);
  process.env.CHANGE_REQUEST_TASK_BUDGET = "80000";
  assert.equal(agentTaskBudget(), 80_000);
  process.env.CHANGE_REQUEST_TASK_BUDGET = "5000";
  assert.equal(agentTaskBudget(), null);
  process.env.CHANGE_REQUEST_TASK_BUDGET = "lots";
  assert.equal(agentTaskBudget(), null);
});

test("cost per MTok: input, output, cache reads and writes; unknown model → null", () => {
  // 1M in × $4 + 1M out × $20
  assert.equal(costUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 24);
  assert.equal(
    costUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    0.2 + 5,
  );
  assert.equal(costUsd("claude-haiku-5-5", { inputTokens: 2_000_000, outputTokens: 1_000_000 }), 0.7);
  assert.equal(costUsd("claude-opus-5-5", { inputTokens: 1234, outputTokens: 567 }), 0.016276);
  assert.equal(costUsd("some-future-model", { inputTokens: 10, outputTokens: 10 }), null);
});

test("tokenUsage reads the SDK usage object, cache fields null-safe", () => {
  assert.deepEqual(
    tokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: 7 }),
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 7 },
  );
});

test("image types the API reads, normalised; anything else → null", () => {
  assert.equal(agentImageType("image/PNG"), "image/png");
  assert.equal(agentImageType("image/jpg"), "image/jpeg");
  assert.equal(agentImageType("image/webp; q=1"), "image/webp");
  assert.equal(agentImageType("application/pdf"), null);
  assert.equal(agentImageType(null), null);
});

test("imageBlock is a base64 image block", () => {
  const block = imageBlock(new Uint8Array([1, 2, 3]), "image/png");
  assert.deepEqual(block, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
});
