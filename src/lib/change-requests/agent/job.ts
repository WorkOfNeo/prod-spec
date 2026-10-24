// =====================================================
// Change-request agent — the job (design §5.7).
//
// One run = one output (issue) of one request. startChangeRequestRun() is what
// routes call: it claims the output (status WORKING, plus an in-process lock so
// a double click can't start two runs), kicks the job off WITHOUT awaiting it
// and returns at once; the request page polls for the result. The job:
//
//   1. loads the request, this output, its screenshots and — on a revision —
//      the thread since the last draft and a summary of the current draft;
//   2. runs the tool-use loop (loop.ts) with the agent tools (tools.ts), every
//      tool call and every model turn (tokens + cost) logged as a step;
//   3. applies the outcome: a finished draft goes to IN_REVIEW with the agent's
//      summary in the thread; a code handoff or a question was already applied
//      by the tool that made it; anything else is FAILED with a plain reason.
//
// Rails (design §2): the job never publishes, reruns or emails — it only moves
// the output's status and writes thread messages and steps. Drafts are created
// by the propose_patch tool, never here.
//
// A run that dies with the process (deploy, crash) would leave the output
// WORKING forever, so each model turn touches the output's updatedAt as a
// heartbeat and failStaleRuns(), wired into the cron sweep, fails outputs with
// no sign of life for 20 minutes. A run that does finish after being failed
// that way finds its output no longer WORKING and leaves it alone.
// =====================================================

import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { orEmpty } from "@/lib/change-requests/db-safe";
import {
  appendMessage,
  getAttachmentImages,
  getOutputWithRequest,
  getRequestDetail,
  logStep,
  setOutputStatus,
  type RequestDetail,
} from "@/lib/change-requests/store";
import { requestRef, type OutputStatus } from "@/lib/change-requests/types";
import { describeLayoutChanges } from "@/lib/output-layouts/ops";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { getSystemPromptContent } from "@/lib/prompts/system-prompts";
import {
  AiNotConfiguredError,
  MAX_IMAGE_BYTES,
  agentEffort,
  agentImageType,
  agentModel,
  agentTaskBudget,
  getAgentClient,
  imageBlock,
} from "@/lib/change-requests/agent/client";
import type { ToolContext } from "@/lib/change-requests/agent/contract";
import { runAgentLoop, type AgentLoopResult } from "@/lib/change-requests/agent/loop";
import { CHANGE_REQUEST_AGENT_PROMPT_KEY, buildSystemPrompt } from "@/lib/change-requests/agent/prompt";
import { AGENT_TOOLS } from "@/lib/change-requests/agent/tools";

export type RunTrigger = "new" | "comment" | "answer" | "resume";
// userId null = started by the system (the cron sweep resuming a code handoff).
export type RunOptions = { trigger: RunTrigger; userId: string | null };
export type StartRunResult = { started: true } | { started: false; reason: string };

export const MAX_TOOL_CALLS = 30;
export const STALE_RUN_MS = 20 * 60_000;

// What a run ended as — returned for tests and callers that await the job.
export type RunOutcome = {
  status: OutputStatus | null;
  reason?: string;
  revisionId?: string;
  // The output had already left WORKING (failed by the sweep, changed by a
  // person) when the run ended, so its result was not applied.
  discarded?: boolean;
};

// ── In-process lock ──────────────────────────────────────────────────────────
// On globalThis so a dev hot reload doesn't forget runs still in flight.
const g = globalThis as typeof globalThis & { __changeRequestRuns?: Set<string> };
const running: Set<string> = (g.__changeRequestRuns ??= new Set<string>());

export function isRunInProgress(outputId: string): boolean {
  return running.has(outputId);
}

// Claim the output and start the job in the background. Refuses an output the
// agent is already working on. Resolves as soon as the output is WORKING.
export async function startChangeRequestRun(outputId: string, opts: RunOptions): Promise<StartRunResult> {
  if (running.has(outputId)) return { started: false, reason: "A run is already in progress for this output" };
  running.add(outputId);
  let requestId: string;
  try {
    const output = await getOutputWithRequest(outputId);
    if (!output) {
      running.delete(outputId);
      return { started: false, reason: "Output not found" };
    }
    if (output.status === "WORKING") {
      running.delete(outputId);
      return { started: false, reason: "The agent is already working on this output" };
    }
    requestId = output.requestId;
    await setOutputStatus(outputId, "WORKING");
  } catch (err) {
    running.delete(outputId);
    throw err;
  }

  void runChangeRequestJob(outputId, opts)
    .catch(async (err) => {
      // runChangeRequestJob records its own failures; this only fires when
      // even that failed (or the output vanished). Last attempt at a status.
      console.error(`[change-requests] run for output ${outputId} crashed:`, err);
      await quietly(() => setOutputStatus(outputId, "FAILED"));
      await quietly(() =>
        appendMessage({
          requestId,
          outputId,
          authorKind: "SYSTEM",
          kind: "status",
          body: `The agent run failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    })
    .finally(() => running.delete(outputId));

  return { started: true };
}

// ── The job ──────────────────────────────────────────────────────────────────

export async function runChangeRequestJob(outputId: string, opts: RunOptions): Promise<RunOutcome> {
  const output = await getOutputWithRequest(outputId);
  if (!output) throw new Error(`Change-request output ${outputId} not found`);
  const requestId = output.requestId;
  const run = { requestId, outputId };

  try {
    const client = getAgentClient();
    const model = agentModel();
    const effort = agentEffort();
    const [detail, attachments, currentDraft, before] = await Promise.all([
      getRequestDetail(requestId),
      getAttachmentImages(requestId, outputId),
      output.currentRevisionId
        ? orEmpty(db.outputLayoutRevision.findUnique({ where: { id: output.currentRevisionId } }), null)
        : Promise.resolve(null),
      revisionIdsFor(outputId),
    ]);
    if (!detail) throw new Error("The request could not be loaded");

    const outputRow = detail.outputs.find((o) => o.id === outputId) ?? output;
    const { content: userContent, images } = buildFirstMessage({
      detail,
      output: outputRow,
      trigger: opts.trigger,
      currentDraft,
      attachments,
    });
    const system = buildSystemPrompt(await getSystemPromptContent(CHANGE_REQUEST_AGENT_PROMPT_KEY), []);

    const ctx: ToolContext = {
      requestId,
      outputId,
      userId: opts.userId,
      log: async (step) => {
        await logStep({ ...run, kind: step.kind, summary: step.summary, detail: step.detail as Prisma.InputJsonValue });
      },
    };

    await logStep({
      ...run,
      kind: "run_start",
      summary: `Run started (${opts.trigger}) · ${model} · effort ${effort}`,
      detail: { trigger: opts.trigger, model, effort, userId: opts.userId, tools: AGENT_TOOLS.map((t) => t.name) },
    });
    if (images > 0) {
      await logStep({ ...run, kind: "read_images", summary: `${images} screenshot${images === 1 ? "" : "s"} sent to the agent` });
    }

    const result = await runAgentLoop({
      client,
      model,
      effort,
      system,
      userContent,
      tools: AGENT_TOOLS,
      ctx,
      maxToolCalls: MAX_TOOL_CALLS,
      taskBudgetTokens: agentTaskBudget(),
      onTurn: async (t) => {
        const prompt = t.usage.inputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens;
        await logStep({
          ...run,
          kind: "model_turn",
          summary:
            `Turn ${t.turn} · ${t.toolCalls.length ? t.toolCalls.join(", ") : `stop: ${t.stopReason ?? "?"}`}` +
            ` · ${prompt.toLocaleString("en")} in / ${t.usage.outputTokens.toLocaleString("en")} out` +
            (t.fallback ? " · served by the refusal fallback" : ""),
          model: t.model,
          // Total prompt tokens (cached + uncached); the split is in detail.
          inputTokens: prompt,
          outputTokens: t.usage.outputTokens,
          costUsd: t.costUsd,
          detail: { ...t.usage, stopReason: t.stopReason, fallback: t.fallback },
        });
        await heartbeat(outputId);
      },
    });

    // Totals live in detail only: the per-turn steps already carry tokens and
    // cost, and the cost signals sum those columns.
    await logStep({
      ...run,
      kind: "run_end",
      summary: `Run ended: ${result.stopReason} · ${result.calls.length} tool call${result.calls.length === 1 ? "" : "s"} · ${result.turns} turn${result.turns === 1 ? "" : "s"}${result.costUsd !== null ? ` · $${result.costUsd.toFixed(4)}` : ""}`,
      detail: {
        stopReason: result.stopReason,
        terminal: result.terminal?.name ?? null,
        calls: result.calls.map((c) => ({ name: c.name, isError: c.isError, durationMs: c.durationMs })),
        usage: result.usage,
        costUsd: result.costUsd,
        ...(result.error ? { error: result.error } : {}),
        ...(result.refusalCategory !== undefined ? { refusalCategory: result.refusalCategory } : {}),
      },
    });

    return await applyOutcome(run, result, before);
  } catch (err) {
    const reason =
      err instanceof AiNotConfiguredError
        ? "AI is not configured (ANTHROPIC_API_KEY)"
        : `The agent run failed: ${err instanceof Error ? err.message : String(err)}`;
    return failRun(run, reason);
  }
}

type RunRef = { requestId: string; outputId: string };

async function applyOutcome(run: RunRef, result: AgentLoopResult, before: Set<string>): Promise<RunOutcome> {
  // declare_gap / ask_reviewer applied their own status (NEEDS_CODE /
  // NEEDS_INFO) and thread message. Only a hand-off that somehow left the
  // output WORKING needs the job, or it would sit there until the sweep.
  if (result.stopReason === "terminal" && result.terminal && result.terminal.name !== "finish") {
    const now = await getOutputWithRequest(run.outputId);
    if (now?.status === "WORKING") {
      return failRun(run, `The agent's hand-off (${result.terminal.name}) did not update the output. Start the run again.`);
    }
    return { status: (now?.status as OutputStatus | undefined) ?? null };
  }

  const now = await getOutputWithRequest(run.outputId);
  if (!now || now.status !== "WORKING") {
    await quietly(() =>
      logStep({
        ...run,
        kind: "error",
        summary: `Run result not applied: the output is ${now ? now.status : "gone"} now`,
      }),
    );
    return { status: (now?.status as OutputStatus | undefined) ?? null, discarded: true };
  }

  switch (result.stopReason) {
    case "terminal":
      return completeWithDraft(run, before, summaryOf(result));
    case "end_turn":
      return completeWithDraft(run, before, result.finalText ?? "");
    case "max_calls":
      return failRun(run, `The agent used all ${MAX_TOOL_CALLS} of its tool calls without finishing.`);
    case "refusal":
      return failRun(
        run,
        `The AI declined to work on this request (safety refusal${result.refusalCategory ? `: ${result.refusalCategory}` : ""}).`,
      );
    case "max_tokens":
      return failRun(run, "The AI's reply was cut off at its output limit before it finished.");
    case "error":
    default:
      return failRun(run, `The agent run failed: ${result.error ?? "unknown error"}`);
  }
}

// finish (or a closing text) → the draft this run made goes to review.
async function completeWithDraft(run: RunRef, before: Set<string>, summary: string): Promise<RunOutcome> {
  const draft = await newestRunDraft(run.outputId, before);
  if (!draft) {
    // Keep what the agent said — often why it made no change (a data problem,
    // not a layout problem) — then fail so an admin looks.
    if (summary.trim()) {
      await appendMessage({ ...run, authorKind: "AGENT", kind: "message", body: summary.trim() });
    }
    return failRun(run, "The agent finished without a draft");
  }
  await setOutputStatus(run.outputId, "IN_REVIEW", {
    currentRevisionId: draft.id,
    draftCount: { increment: 1 },
  });
  await appendMessage({
    ...run,
    authorKind: "AGENT",
    kind: "message",
    body: summary.trim() || "Draft ready for review.",
    revisionId: draft.id,
  });
  return { status: "IN_REVIEW", revisionId: draft.id };
}

async function failRun(run: RunRef, reason: string): Promise<RunOutcome> {
  await setOutputStatus(run.outputId, "FAILED");
  await appendMessage({ ...run, authorKind: "SYSTEM", kind: "status", body: reason });
  await quietly(() => logStep({ ...run, kind: "error", summary: reason }));
  return { status: "FAILED", reason };
}

// The finish tool's summary: its input carries it (the model wrote it for the
// reviewer); fall back to what the tool returned, then to closing text.
function summaryOf(result: AgentLoopResult): string {
  const pick = (v: unknown): string | null => {
    if (!v || typeof v !== "object") return null;
    for (const key of ["summary", "message", "text"]) {
      const s = (v as Record<string, unknown>)[key];
      if (typeof s === "string" && s.trim()) return s;
    }
    return null;
  };
  const t = result.terminal;
  return pick(t?.input) ?? pick(t?.result.content) ?? result.finalText ?? "";
}

// ── Revisions made by this run ───────────────────────────────────────────────
// Snapshot of the output's revision ids before the run; afterwards the newest
// DRAFT not in it is this run's draft. Comparing ids (not timestamps) keeps it
// independent of clock skew between app and database.

async function revisionIdsFor(outputId: string): Promise<Set<string>> {
  const rows = await orEmpty(
    db.outputLayoutRevision.findMany({ where: { changeRequestOutputId: outputId }, select: { id: true } }),
    [] as { id: string }[],
  );
  return new Set(rows.map((r) => r.id));
}

async function newestRunDraft(outputId: string, before: Set<string>): Promise<{ id: string } | null> {
  const drafts = await orEmpty(
    db.outputLayoutRevision.findMany({
      where: { changeRequestOutputId: outputId, status: "DRAFT" },
      orderBy: [{ createdAt: "desc" }, { number: "desc" }],
      select: { id: true },
    }),
    [] as { id: string }[],
  );
  return drafts.find((d) => !before.has(d.id)) ?? null;
}

// Liveness for failStaleRuns. Only touches an output that is still WORKING.
async function heartbeat(outputId: string): Promise<void> {
  await quietly(() =>
    db.changeRequestOutput.updateMany({ where: { id: outputId, status: "WORKING" }, data: { updatedAt: new Date() } }),
  );
}

// ── The first user message ───────────────────────────────────────────────────

type OutputRow = RequestDetail["outputs"][number];
type MessageRow = RequestDetail["messages"][number];
type AttachmentRow = Awaited<ReturnType<typeof getAttachmentImages>>[number];
type RevisionRow = { number: number; status: string; definition: unknown; baseDefinition: unknown };

// Pure: the request, this output, the trigger's context and the screenshots,
// as content blocks. Exported for tests.
export function buildFirstMessage(input: {
  detail: Pick<RequestDetail, "number" | "title" | "message" | "source" | "poNumber" | "styleId" | "outputs" | "messages">;
  output: Pick<OutputRow, "id" | "label" | "text" | "variantKey" | "layoutId" | "styleId" | "awaitingToken">;
  trigger: RunTrigger;
  currentDraft: RevisionRow | null;
  attachments: AttachmentRow[];
}): { content: Anthropic.Beta.BetaContentBlockParam[]; images: number } {
  const { detail, output, trigger, currentDraft, attachments } = input;
  const parts: string[] = [];

  parts.push(`Change request ${requestRef(detail.number)}: ${detail.title}`);
  const facts = [
    `filed by ${detail.source === "REQUESTER" ? "a reviewer" : "an admin"}`,
    detail.poNumber ? `PO ${detail.poNumber}` : null,
    detail.styleId ? `picked style id ${detail.styleId}` : "no single style picked",
  ].filter(Boolean);
  parts.push(`(${facts.join(" · ")})`);
  parts.push(`The request as written:\n"""\n${detail.message.trim()}\n"""`);

  parts.push(`This run works on ONE output: "${output.label}".`);
  parts.push(`The issue for this output:\n"""\n${output.text.trim()}\n"""`);
  const hints = [
    output.variantKey ? `variant key ${output.variantKey}` : null,
    output.layoutId ? `layout id ${output.layoutId}` : null,
    output.styleId ? `representative style id ${output.styleId} (use it for proofs)` : null,
  ].filter(Boolean);
  if (hints.length) parts.push(`Known for this output: ${hints.join(" · ")}.`);
  const others = detail.outputs.filter((o) => o.id !== output.id).map((o) => `"${o.label}"`);
  if (others.length) {
    parts.push(`Other outputs in this request are handled in their own runs — leave them alone: ${others.join(", ")}.`);
  }

  if (trigger === "comment" || trigger === "answer") {
    const thread = threadSinceLastDraft(detail.messages, output.id);
    const heading =
      trigger === "comment"
        ? "A reviewer commented on your draft. The thread since your last draft:"
        : "You asked the reviewer a question. The thread since your last draft, with their answer:";
    parts.push(thread.length ? `${heading}\n${thread.map(formatMessage).join("\n")}` : `${heading}\n(no messages)`);
  }
  if (trigger === "resume" && output.awaitingToken) {
    parts.push(
      `This output was waiting for a new token, {{${output.awaitingToken}}}. It is now available: continue the change using it.`,
    );
  }

  if (currentDraft) {
    parts.push(describeDraft(currentDraft));
    if (trigger === "comment" || trigger === "answer") {
      parts.push("Revise this draft for the thread above rather than starting over, unless it asks for something different.");
    }
  }

  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  let images = 0;
  const imageBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  attachments.forEach((a, i) => {
    const label = `Screenshot ${i + 1}: ${a.fileName}`;
    const type = agentImageType(a.mimeType);
    if (!type) {
      imageBlocks.push({ type: "text", text: `${label} (${a.mimeType}) is not an image the agent can read.` });
      return;
    }
    if (a.data.byteLength > MAX_IMAGE_BYTES) {
      imageBlocks.push({ type: "text", text: `${label} is too large to send (${Math.round(a.data.byteLength / 1024)} KB).` });
      return;
    }
    imageBlocks.push({ type: "text", text: label });
    imageBlocks.push(imageBlock(a.data, type));
    images++;
  });
  parts.push(
    attachments.length
      ? `${attachments.length} screenshot${attachments.length === 1 ? "" : "s"} follow${attachments.length === 1 ? "s" : ""}.`
      : "No screenshots were attached.",
  );

  blocks.push({ type: "text", text: parts.join("\n\n") });
  blocks.push(...imageBlocks);
  return { content: blocks, images };
}

// Messages for this output (and request-wide ones) after the agent's last
// draft message. With no draft yet, the whole thread.
export function threadSinceLastDraft(messages: readonly MessageRow[], outputId: string): MessageRow[] {
  const mine = messages.filter((m) => m.outputId === outputId || m.outputId === null);
  let last = -1;
  mine.forEach((m, i) => {
    if (m.authorKind === "AGENT" && m.revisionId) last = i;
  });
  return mine.slice(last + 1);
}

function formatMessage(m: Pick<MessageRow, "authorKind" | "kind" | "body">): string {
  const who = m.authorKind === "AGENT" ? "You" : m.authorKind === "SYSTEM" ? "System" : "Reviewer";
  const what = m.kind === "question" ? " (question)" : "";
  return `- ${who}${what}: ${m.body.trim()}`;
}

function describeDraft(rev: RevisionRow): string {
  let lines: string[];
  try {
    // Block ids help the agent address the draft's blocks when it revises them.
    lines = describeLayoutChanges(rev.baseDefinition as LayoutDef, rev.definition as LayoutDef).map((c) =>
      c.blockId && !c.summary.includes(c.blockId) ? `- ${c.summary} (block ${c.blockId})` : `- ${c.summary}`,
    );
  } catch {
    lines = ["- (the changes could not be summarised)"];
  }
  const state = rev.status === "DRAFT" ? "" : ` (now ${rev.status.toLowerCase()})`;
  return (
    `The current draft is revision #${rev.number}${state}. Its changes against the layout that was live when it was drafted:\n` +
    (lines.length ? lines.join("\n") : "- (no changes)")
  );
}

// ── Stale runs (cron sweep) ──────────────────────────────────────────────────

// Fail WORKING outputs with no sign of life (status change or model turn) for
// maxAgeMs. Idempotent; returns the ids it failed.
export async function failStaleRuns(maxAgeMs: number = STALE_RUN_MS): Promise<{ failed: string[] }> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const stale = await orEmpty(
    db.changeRequestOutput.findMany({
      where: { status: "WORKING", updatedAt: { lt: cutoff } },
      select: { id: true, requestId: true },
    }),
    [] as { id: string; requestId: string }[],
  );
  const minutes = Math.max(1, Math.round(maxAgeMs / 60_000));
  const failed: string[] = [];
  for (const o of stale) {
    try {
      await setOutputStatus(o.id, "FAILED");
      await appendMessage({
        requestId: o.requestId,
        outputId: o.id,
        authorKind: "SYSTEM",
        kind: "status",
        body: `The agent stopped responding (no progress for ${minutes} minutes), so the run was stopped. Start it again from the request page.`,
      });
      await quietly(() =>
        logStep({ requestId: o.requestId, outputId: o.id, kind: "error", summary: `Stale run failed after ${minutes} min` }),
      );
      failed.push(o.id);
    } catch (err) {
      console.error(`[change-requests] could not fail stale run ${o.id}:`, err);
    }
  }
  return { failed };
}

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error("[change-requests] job write failed:", err);
  }
}
