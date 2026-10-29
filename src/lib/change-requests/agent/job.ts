// =====================================================
// Change-request agent — the job (design §5.7).
//
// One run = one output (issue) of one request. startChangeRequestRun() is what
// routes call: it claims the output (one conditional write to WORKING, plus an
// in-process lock so a double click can't start two runs), kicks the job off
// WITHOUT awaiting it and returns at once; the request page polls for the
// result. The job:
//
//   1. loads the request, this output, its screenshots and — on a revision —
//      the thread since the last draft and a summary of the current draft;
//   2. runs the tool-use loop (loop.ts) with the agent tools (tools.ts), every
//      tool call and every model turn (tokens + cost) logged as a step;
//   3. applies the outcome: a run that made a draft hands it to review with the
//      agent's summary in the thread; a run that only answered (a question, or
//      "no layout change is needed or possible") goes to review with that
//      answer and the current draft, if any, left as it is; a code handoff or a
//      question was already applied by the tool that made it; only a run that
//      broke (budget spent, refusal, cut off, error, AI not configured) is
//      FAILED with a plain reason.
//
// Rails (design §2): the job never publishes, reruns or emails — it only moves
// the output's status and writes thread messages and steps. Drafts are created
// by the propose_patch tool, never here.
//
// A run that dies with the process (deploy, crash) would leave the output
// WORKING forever, so each model turn and (at most every 30 s) each tool step
// touches the output's updatedAt as a heartbeat, and failStaleRuns(), wired
// into the cron sweep, fails outputs with no sign of life for 20 minutes. A
// run that does finish after being failed that way finds its output no longer
// WORKING and leaves it alone; its tools refuse to write for the same reason.
// =====================================================

import type Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { orEmpty } from "@/lib/change-requests/db-safe";
import {
  appendMessage,
  getAttachmentImages,
  getOutputWithRequest,
  getRequestDetail,
  logStep,
  rollUpRequestStatus,
  setOutputStatus,
  type RequestDetail,
} from "@/lib/change-requests/store";
import { requestRef, type OutputStatus } from "@/lib/change-requests/types";
import { describeLayoutChanges } from "@/lib/output-layouts/ops";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
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
import { memoriesForPrompt } from "@/lib/change-requests/memory";
import { AGENT_TOOLS } from "@/lib/change-requests/agent/tools";

export type RunTrigger = "new" | "comment" | "answer" | "resume";
// userId null = started by the system (the cron sweep resuming a code handoff).
export type RunOptions = { trigger: RunTrigger; userId: string | null };
export type StartRunResult = { started: true } | { started: false; reason: string };

export const MAX_TOOL_CALLS = 30;
export const STALE_RUN_MS = 20 * 60_000;
// Tool steps refresh the heartbeat at most this often (model turns always do).
export const HEARTBEAT_THROTTLE_MS = 30_000;

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
// On globalThis so a dev hot reload doesn't forget runs still in flight. Each
// entry remembers when its run started: an entry older than the stale-run
// threshold belongs to a run that hung (the sweep has failed its output by
// then), so it no longer blocks a new start. Only the run that owns an entry
// removes it, so a hung run that finally ends can't unlock a newer one.
type RunLock = { startedAt: number };
const g = globalThis as typeof globalThis & { __changeRequestRunLocks?: Map<string, RunLock> };
const running: Map<string, RunLock> = (g.__changeRequestRunLocks ??= new Map<string, RunLock>());

function lockHeld(outputId: string): boolean {
  const lock = running.get(outputId);
  return lock !== undefined && Date.now() - lock.startedAt < STALE_RUN_MS;
}

function releaseLock(outputId: string, lock: RunLock): void {
  if (running.get(outputId) === lock) running.delete(outputId);
}

export function isRunInProgress(outputId: string): boolean {
  return lockHeld(outputId);
}

// The statuses a run may start from. Never WORKING (a run holds the output)
// and never APPROVED / PUBLISHED / REJECTED (a person has settled it).
export const CLAIMABLE_STATUSES = [
  "NEW",
  "FAILED",
  "IN_REVIEW",
  "NEEDS_INFO",
  "NEEDS_CODE",
] as const satisfies readonly OutputStatus[];

function claimRefusal(status: string | null): string {
  if (status === null) return "Output not found";
  if (status === "WORKING") return "The agent is already working on this output";
  return `The output is ${status.toLowerCase().replace(/_/g, " ")}, so the agent can't start on it`;
}

// Start the agent on every output of a freshly filed request. Called by the
// create route right after the request is written; each start only claims the
// output and returns, so filing never waits on the model. Fail-soft per output:
// a request that could not start shows its outputs as NEW with a "Start" button.
export async function startRunsForRequest(requestId: string, userId: string | null): Promise<StartRunResult[]> {
  const outputs = await orEmpty(
    db.changeRequestOutput.findMany({ where: { requestId, status: "NEW" }, select: { id: true }, orderBy: { position: "asc" } }),
    [],
  );
  const results: StartRunResult[] = [];
  for (const o of outputs) {
    try {
      results.push(await startChangeRequestRun(o.id, { trigger: "new", userId }));
    } catch (err) {
      console.warn(`[change-requests] could not start a run for output ${o.id}:`, err);
      results.push({ started: false, reason: "Could not start the agent" });
    }
  }
  return results;
}

// Claim the output and start the job in the background. Resolves as soon as
// the output is WORKING. The claim is ONE conditional write (status still
// claimable → WORKING), so two app processes, or a click racing the sweep's
// resume, can't both win it; the in-process lock only spares the database a
// double click.
export async function startChangeRequestRun(outputId: string, opts: RunOptions): Promise<StartRunResult> {
  if (lockHeld(outputId)) return { started: false, reason: "A run is already in progress for this output" };
  const lock: RunLock = { startedAt: Date.now() };
  running.set(outputId, lock);
  let requestId: string;
  try {
    const output = await getOutputWithRequest(outputId);
    if (!output) {
      releaseLock(outputId, lock);
      return { started: false, reason: "Output not found" };
    }
    const claim = await db.changeRequestOutput.updateMany({
      where: { id: outputId, status: { in: [...CLAIMABLE_STATUSES] } },
      data: { status: "WORKING" },
    });
    if (claim.count === 0) {
      releaseLock(outputId, lock);
      // Re-read: a claimable status read a moment ago means someone else just
      // moved it (most likely another start).
      const now = await getOutputWithRequest(outputId);
      return { started: false, reason: claimRefusal(now ? now.status : null) };
    }
    requestId = output.requestId;
  } catch (err) {
    releaseLock(outputId, lock);
    throw err;
  }
  // The request's status follows its outputs. A failed roll-up must not
  // strand a claimed output without its run; the run's own status changes
  // roll the request up again.
  await quietly(() => rollUpRequestStatus(requestId));

  // A run whose lock was taken over (it hung past the stale threshold and a
  // new run started) must not apply its late result over the new run's.
  const isCurrent = () => running.get(outputId) === lock;
  void runChangeRequestJob(outputId, opts, isCurrent)
    .catch(async (err) => {
      // runChangeRequestJob records its own failures; this only fires when
      // even that failed (or the output vanished). Last attempt at a status.
      console.error(`[change-requests] run for output ${outputId} crashed:`, err);
      if (!isCurrent()) return;
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
    .finally(() => releaseLock(outputId, lock));

  return { started: true };
}

// The kept memory notes that apply to this run (global, this customer, this
// layout's document type, Monday), as one prompt block. Any failure reads as
// "no notes": memory improves a run, it must never be the reason one fails.
async function loadMemoryNotes(customerId: string | null, layoutId: string | null): Promise<string> {
  try {
    const docType = layoutId
      ? (await orEmpty(db.outputLayout.findUnique({ where: { id: layoutId }, select: { docType: true } }), null))?.docType
      : undefined;
    const memory = await memoriesForPrompt({ customerId: customerId ?? undefined, docType: docType ?? undefined });
    return memory.text;
  } catch (err) {
    console.warn("[change-requests] memory notes unavailable for this run:", err);
    return "";
  }
}

// ── The job ──────────────────────────────────────────────────────────────────

// `isCurrent` answers whether this run still owns the output (see
// startChangeRequestRun); a run that doesn't applies nothing when it ends.
export async function runChangeRequestJob(
  outputId: string,
  opts: RunOptions,
  isCurrent: () => boolean = () => true,
): Promise<RunOutcome> {
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
    // Kept memory notes for this customer, this document type and Monday
    // (design §5.9). Reading them bumps their used count.
    // Fail-soft: notes that cannot be read never stop a run.
    const memoryText = await loadMemoryNotes(detail.customerId, outputRow.layoutId);
    const system = buildSystemPrompt(
      await getSystemPromptContent(CHANGE_REQUEST_AGENT_PROMPT_KEY),
      memoryText ? [memoryText] : [],
    );

    // One heartbeat per run: every model turn beats, tool steps at most every
    // HEARTBEAT_THROTTLE_MS, so a long phase of tool calls (proofs, impact)
    // between two turns is not mistaken for a dead run.
    const beat = heartbeatFor(outputId);
    const ctx: ToolContext = {
      requestId,
      outputId,
      userId: opts.userId,
      log: async (step) => {
        try {
          await logStep({ ...run, kind: step.kind, summary: step.summary, detail: step.detail as Prisma.InputJsonValue });
        } finally {
          await beat();
        }
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
        await beat(true);
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

    if (!isCurrent()) return superseded(run);
    return await applyOutcome(run, result, before);
  } catch (err) {
    if (!isCurrent()) return superseded(run);
    const reason =
      err instanceof AiNotConfiguredError
        ? "AI is not configured (ANTHROPIC_API_KEY)"
        : `The agent run failed: ${err instanceof Error ? err.message : String(err)}`;
    return failRun(run, reason);
  }
}

type RunRef = { requestId: string; outputId: string };

async function superseded(run: RunRef): Promise<RunOutcome> {
  await quietly(() =>
    logStep({ ...run, kind: "error", summary: "Run result not applied: a newer run took over this output" }),
  );
  return { status: null, discarded: true };
}

async function applyOutcome(run: RunRef, result: AgentLoopResult, before: Set<string>): Promise<RunOutcome> {
  // declare_gap / ask_reviewer applied their own status (NEEDS_CODE /
  // NEEDS_INFO / IN_REVIEW) and thread message. Only a hand-off that somehow
  // left the output WORKING needs the job, or it would sit there until the
  // sweep. A draft the run made before handing off still counts as a draft
  // (draftCount) and stays the output's current one.
  if (result.stopReason === "terminal" && result.terminal && result.terminal.name !== "finish") {
    const now = await getOutputWithRequest(run.outputId);
    if (now?.status === "WORKING") {
      return failRun(run, `The agent's hand-off (${result.terminal.name}) did not update the output. Start the run again.`);
    }
    const draft = now ? await newestRunDraft(run.outputId, before) : null;
    if (now && draft) {
      await db.changeRequestOutput.updateMany({
        // Same status the hand-off left: never rewrite an output a person
        // moved on meanwhile.
        where: { id: run.outputId, status: now.status },
        data: { draftCount: { increment: 1 }, ...currentRevisionPatch(now.currentRevisionId, draft.id) },
      });
    }
    return { status: (now?.status as OutputStatus | undefined) ?? null, ...(draft ? { revisionId: draft.id } : {}) };
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
      return completeRun(run, now, before, summaryOf(result));
    case "end_turn":
      return completeRun(run, now, before, result.finalText ?? "");
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

// Point the output at `draftId`. A stored impact belongs to the revision it
// was computed for, so moving to another revision drops it in the same write
// (the review screen then recomputes it for the new one).
function currentRevisionPatch(currentRevisionId: string | null, draftId: string) {
  return currentRevisionId === draftId
    ? { currentRevisionId: draftId }
    : { currentRevisionId: draftId, impact: Prisma.DbNull };
}

// finish (or a closing text). Every way of ending the run on purpose goes to
// review — only a broken run is FAILED:
//   • a draft made in this run → it becomes current, draftCount + 1, the
//     agent's summary in the thread attached to it;
//   • no new draft (the reviewer only asked a question, or no layout change is
//     needed or possible) → the agent's answer in the thread; the current
//     draft, if the output has one, stays current and untouched, so the
//     reviewer can approve it, reply, or close the request.
async function completeRun(
  run: RunRef,
  now: { currentRevisionId: string | null },
  before: Set<string>,
  summary: string,
): Promise<RunOutcome> {
  const draft = await newestRunDraft(run.outputId, before);
  if (draft) {
    await setOutputStatus(run.outputId, "IN_REVIEW", {
      draftCount: { increment: 1 },
      ...currentRevisionPatch(now.currentRevisionId, draft.id),
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

  const current = await openCurrentDraft(now.currentRevisionId);
  await setOutputStatus(run.outputId, "IN_REVIEW");
  // Not attached to the draft (no revisionId): the draft's own summary stays
  // the one the review screen shows next to it.
  if (summary.trim()) {
    await appendMessage({ ...run, authorKind: "AGENT", kind: "message", body: summary.trim() });
  } else {
    await appendMessage({
      ...run,
      authorKind: "SYSTEM",
      kind: "status",
      body: current
        ? "The agent ended its run without a new draft or a reply. The current draft is unchanged."
        : "The agent ended its run without a draft or an explanation. Reply to ask it again, or close the request.",
    });
  }
  return { status: "IN_REVIEW", ...(current ? { revisionId: current.id } : {}) };
}

// The output's current revision when it is an open DRAFT.
async function openCurrentDraft(revisionId: string | null): Promise<{ id: string } | null> {
  if (!revisionId) return null;
  const rev = await orEmpty(
    db.outputLayoutRevision.findUnique({ where: { id: revisionId }, select: { id: true, status: true } }),
    null,
  );
  return rev && rev.status === "DRAFT" ? { id: rev.id } : null;
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

// A heartbeat that writes at most once per HEARTBEAT_THROTTLE_MS unless forced.
function heartbeatFor(outputId: string): (force?: boolean) => Promise<void> {
  let last = Number.NEGATIVE_INFINITY;
  return async (force = false) => {
    const now = Date.now();
    if (!force && now - last < HEARTBEAT_THROTTLE_MS) return;
    last = now;
    await heartbeat(outputId);
  };
}

// ── The first user message ───────────────────────────────────────────────────

// The cover isn't a layout, so the system prompt's "draft the smallest layout
// change" doesn't fit it. Said here rather than in the (admin-editable)
// prompt: a run on the cover gets it whatever the prompt says.
export const COVER_BRIEFING =
  'This output is the cover document ("Prod Spec", the first PDF of every bundle). It is printed by code, not drawn from an ' +
  "Output Builder layout: you cannot draft a change to it, and nothing you do here changes it. Read it with get_cover, work out " +
  "which part the request is about, and end with finish: a suggestion the admin applies by hand — the part to change, where it is " +
  "changed (get_cover's whereToChange), the exact new wording when it is text, and how many covers that reaches (the cover block is on " +
  "every cover; general information on every style of the prod spec). When only the cover's code can make the change (a new column, " +
  "another order, anything no setting controls), say so in finish and describe the change for a developer; declare_gap is only for a " +
  "missing layout variable. When it is unclear which part is meant, ask the reviewer.";

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
  if (output.variantKey === COVER_VARIANT_KEY) parts.push(COVER_BRIEFING);
  const others = detail.outputs.filter((o) => o.id !== output.id).map((o) => `"${o.label}"`);
  if (others.length) {
    parts.push(`Other outputs in this request are handled in their own runs — leave them alone: ${others.join(", ")}.`);
  }

  // An open draft is what a comment is "on". Without one (the agent answered
  // last time, or its draft was discarded) the admin is replying to the agent.
  const openDraft = currentDraft?.status === "DRAFT";
  if (trigger === "comment" || trigger === "answer") {
    const thread = threadSinceLastDraft(detail.messages, output.id);
    const heading =
      trigger === "answer"
        ? "You asked the reviewer a question. The thread since your last draft, with their answer:"
        : openDraft
          ? "A reviewer commented on your draft. The thread since your last draft:"
          : "The admin replied to you. The thread so far:";
    parts.push(thread.length ? `${heading}\n${thread.map(formatMessage).join("\n")}` : `${heading}\n(no messages)`);
  }
  if (trigger === "resume" && output.awaitingToken) {
    parts.push(
      `This output was waiting for a new variable, "${output.awaitingToken}". It exists now — list_tokens shows how it is written ` +
        "(as a variable, or as a source of a graphics token) and what it prints — so continue the change with it.",
    );
  }

  if (currentDraft) {
    parts.push(describeDraft(currentDraft));
    if (openDraft && (trigger === "comment" || trigger === "answer")) {
      parts.push(
        "Revise this draft for the thread above rather than starting over, unless it asks for something different. " +
          "If the thread only asks a question, answer it with finish and leave the draft as it is.",
      );
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
