// =====================================================
// Change requests — approve, publish, rerun, reject (design
// docs/plans/change-requests.md §5.8). SERVER-ONLY (imports db).
//
// The only place a change request changes what prints, and only ever from an
// admin-initiated route (design §2, rail 2). Three actions:
//
//   approveOutput           the admin approves the output's current draft:
//                           publishRevision() puts it live (version bump),
//                           then a FRESH impact of what actually changed picks
//                           the documents to rerun — changed, not approved,
//                           no run in flight — and enqueues one scoped job per
//                           style (triggerSource CHANGE_REQUEST, so the runner
//                           never re-arms the supplier digest and never
//                           auto-approves). The requester hears it is live.
//
//   rerunApprovedDocuments  the explicit SECOND confirmation (rail 3): changed
//                           documents that were already approved go back to
//                           review. Delivery to a supplier still only happens
//                           when someone approves them again.
//
//   rejectOutput            no change: the output's open drafts are discarded,
//                           the reason is kept and sent to the requester.
//
// Why a fresh impact after publishing, and why base vs published: the impact
// stored on the output compared the draft with the layout that was live THEN.
// impactForRevision() after the publish would compare the live definition
// with itself (nothing changed). What was live before the publish is the
// draft's baseDefinition — the unforced publish refuses unless the live row
// still equals it — so "what actually changed" is base → published. Only a
// forced publish (over a builder edit) had something else live before it;
// then that definition, read just before the publish, is the "before".
//
// Approved documents are never rerun by approveOutput, and that is decided per
// STYLE, not per document: a scoped job regenerates every document of the
// output for the style (the runner matches the base key), so a split output
// whose sizes are partly approved can't be rerun without rerunning the
// approved ones. Such a style waits for rerunApprovedDocuments with its
// approved documents.
//
// Everything after the publish is fail-soft: the layout is already live, so a
// failed impact, enqueue, proof or email is recorded in the thread instead of
// turning a successful publish into an error. And if an approval dies half
// way (or the draft was published from the layout's History panel), approving
// again finds the draft PUBLISHED and finishes the bookkeeping.
//
// Pure decisions (planScopedRerun, planApprovedRerun, the summary texts,
// normaliseRejectReason) are exported and tested on their own.
// =====================================================

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { enqueueBulkRun, type BulkRunResult, type RunnableStyle } from "@/lib/queue/bulk-run";
import { getCurrentOutputsForStyles } from "@/lib/outputs/current-outputs";
import {
  RevisionStateError,
  discardDraft,
  getRevision,
  publishRevision,
  type RevisionRow,
} from "@/lib/output-layouts/revisions";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { orEmpty } from "@/lib/change-requests/db-safe";
import { sendRequesterUpdate } from "@/lib/change-requests/emails";
import { computeImpact } from "@/lib/change-requests/impact";
import { renderProof } from "@/lib/change-requests/proofs";
import { appendMessage, getOutputWithRequest, setOutputStatus } from "@/lib/change-requests/store";
import { requestRef, type ImpactRow, type ImpactSummary, type RevisionStatus } from "@/lib/change-requests/types";
import {
  OutputNotFoundError,
  OutputStateError,
  PublishInputError,
  REJECT_REASON_MAX,
} from "@/lib/change-requests/publish-errors";

export { OutputNotFoundError, OutputStateError, PublishInputError, REJECT_REASON_MAX };

export const REPLACED_DRAFT_MESSAGE = "This draft was replaced by another publish; ask the agent for a new draft";

// ── Pure: who reruns ─────────────────────────────────────────────────────────

export type ScopedRerunPlan = {
  // One scoped job per style, on the output's BASE key (layout:<id>).
  runnable: RunnableStyle[];
  // The changed documents those jobs regenerate.
  rerunRows: ImpactRow[];
  // Changed documents already approved: wait for the explicit second
  // confirmation (rerunApprovedDocuments).
  approvedChanged: ImpactRow[];
  // Changed documents whose output was already uploaded or emailed to the
  // supplier (any review status).
  deliveredChanged: ImpactRow[];
  // Changed, not approved, but their style also has an approved document of
  // this output: rerunning the style would rerun that one too.
  heldByApproved: ImpactRow[];
  // Changed, not approved, but a run is in flight for the style.
  skippedInFlight: ImpactRow[];
  // Changed but never generated (review status NONE): nothing to rerun; the
  // style's first run prints the new layout anyway.
  neverGenerated: ImpactRow[];
};

function groupByStyle(rows: readonly ImpactRow[]): Map<string, ImpactRow[]> {
  const byStyle = new Map<string, ImpactRow[]>();
  for (const r of rows) {
    const list = byStyle.get(r.styleId);
    if (list) list.push(r);
    else byStyle.set(r.styleId, [r]);
  }
  return byStyle;
}

function runnableFor(styleId: string, docs: readonly ImpactRow[], styleProdSpec: ReadonlyMap<string, string | null>) {
  return {
    id: styleId,
    prodSpecId: styleProdSpec.get(styleId) ?? null,
    variantKeys: [...new Set(docs.map((d) => baseVariantKey(d.variantKey)))],
  } satisfies RunnableStyle;
}

// The automatic rerun after a publish. Per style, in impact-row order.
export function planScopedRerun(
  rows: readonly ImpactRow[],
  styleProdSpec: ReadonlyMap<string, string | null>,
): ScopedRerunPlan {
  const plan: ScopedRerunPlan = {
    runnable: [],
    rerunRows: [],
    approvedChanged: [],
    deliveredChanged: [],
    heldByApproved: [],
    skippedInFlight: [],
    neverGenerated: [],
  };
  for (const [styleId, docs] of groupByStyle(rows)) {
    const changed = docs.filter((d) => d.changed);
    if (changed.length === 0) continue;
    for (const d of changed) {
      if (d.reviewStatus === "APPROVED") plan.approvedChanged.push(d);
      if (d.uploaded || d.emailed) plan.deliveredChanged.push(d);
    }
    const open = changed.filter((d) => d.reviewStatus !== "APPROVED");
    if (open.length === 0) continue;
    if (docs.some((d) => d.inFlight)) {
      plan.skippedInFlight.push(...open);
    } else if (docs.some((d) => d.reviewStatus === "APPROVED")) {
      plan.heldByApproved.push(...open);
    } else if (open.every((d) => d.reviewStatus === "NONE")) {
      plan.neverGenerated.push(...open);
    } else {
      plan.runnable.push(runnableFor(styleId, open, styleProdSpec));
      plan.rerunRows.push(...open);
    }
  }
  return plan;
}

export type ApprovedRerunPlan = {
  runnable: RunnableStyle[];
  // The approved changed documents sent back to review.
  rerunRows: ImpactRow[];
  skippedInFlight: ImpactRow[];
  // Approved, but the current document was generated after the publish — it
  // already prints the new layout, so it is not "changed" any more.
  alreadyCurrent: ImpactRow[];
};

export function docRef(styleId: string, variantKey: string): string {
  return `${styleId}\u0000${variantKey}`;
}

// The explicit second confirmation: changed documents that are approved,
// optionally only on the picked styles. `regenerated` holds docRef()s whose
// current document was generated after the publish.
export function planApprovedRerun(
  rows: readonly ImpactRow[],
  opts: {
    styleProdSpec: ReadonlyMap<string, string | null>;
    styleIds?: readonly string[] | null;
    regenerated?: ReadonlySet<string>;
  },
): ApprovedRerunPlan {
  const allow = opts.styleIds ? new Set(opts.styleIds) : null;
  const plan: ApprovedRerunPlan = { runnable: [], rerunRows: [], skippedInFlight: [], alreadyCurrent: [] };
  for (const [styleId, docs] of groupByStyle(rows)) {
    if (allow && !allow.has(styleId)) continue;
    const approved = docs.filter((d) => d.changed && d.reviewStatus === "APPROVED");
    const stale = approved.filter((d) => !opts.regenerated?.has(docRef(d.styleId, d.variantKey)));
    plan.alreadyCurrent.push(...approved.filter((d) => !stale.includes(d)));
    if (stale.length === 0) continue;
    if (docs.some((d) => d.inFlight)) {
      plan.skippedInFlight.push(...stale);
      continue;
    }
    plan.runnable.push(runnableFor(styleId, stale, opts.styleProdSpec));
    plan.rerunRows.push(...stale);
  }
  return plan;
}

// ── Pure: what the thread says ───────────────────────────────────────────────

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function distinctStyles(rows: readonly ImpactRow[]): number {
  return new Set(rows.map((r) => r.styleId)).size;
}

export type RerunOutcome = Pick<BulkRunResult, "enqueued" | "batchId" | "skippedNoPo" | "skippedBelowCutoff">;

function skippedByEnqueue(rerun: RerunOutcome | null): string | null {
  if (!rerun) return null;
  const parts: string[] = [];
  if (rerun.skippedNoPo > 0) parts.push(`${plural(rerun.skippedNoPo, "style")} without a PO number`);
  if (rerun.skippedBelowCutoff > 0) parts.push(`${plural(rerun.skippedBelowCutoff, "style")} below the generation cutoff`);
  return parts.length > 0 ? `Not rerun: ${parts.join(", ")}.` : null;
}

export function publishSummaryText(input: {
  publishedVersion: number;
  forced: boolean;
  plan: ScopedRerunPlan | null;
  rerun: RerunOutcome | null;
  impactError?: string | null;
  rerunError?: string | null;
}): string {
  const lines: string[] = [`Published as layout version ${input.publishedVersion}.`];
  if (input.forced) lines.push("It was published over newer edits to the layout (publish anyway).");
  const { plan } = input;
  if (!plan) {
    lines.push(
      `Could not work out which documents changed${input.impactError ? ` (${input.impactError})` : ""}, so nothing was rerun. ` +
        "Documents waiting for review show as changed in the usual rerun lists.",
    );
    return lines.join(" ");
  }

  const styles = plan.runnable.length;
  if (styles === 0) {
    lines.push("No documents waiting for review needed a rerun.");
  } else if (input.rerunError) {
    lines.push(
      `The rerun of ${plural(plan.rerunRows.length, "changed document")} could not be started (${input.rerunError}); ` +
        "they show as changed in the usual rerun lists.",
    );
  } else {
    const enqueued = input.rerun?.enqueued ?? 0;
    const onStyles = enqueued === styles ? plural(styles, "style") : `${enqueued} of ${plural(styles, "style")}`;
    lines.push(
      `${plural(plan.rerunRows.length, "changed document")} rerun on ${onStyles}; they go back to review with the new layout.`,
    );
    const skipped = skippedByEnqueue(input.rerun);
    if (skipped) lines.push(skipped);
  }
  if (plan.skippedInFlight.length > 0) {
    lines.push(
      `${plural(plan.skippedInFlight.length, "changed document")} skipped because a run was already in progress for ` +
        `${distinctStyles(plan.skippedInFlight) === 1 ? "its style" : "their styles"}; rerun them once it finishes.`,
    );
  }
  if (plan.approvedChanged.length > 0) {
    lines.push(
      `${plural(plan.approvedChanged.length, "approved document")} changed and ${plan.approvedChanged.length === 1 ? "waits" : "wait"} ` +
        "for an explicit rerun; until then they stay approved as they are.",
    );
  }
  if (plan.heldByApproved.length > 0) {
    lines.push(
      `${plural(plan.heldByApproved.length, "other changed document")} ${plan.heldByApproved.length === 1 ? "waits" : "wait"} ` +
        "with them, because rerunning a style reruns its approved documents of this output too.",
    );
  }
  if (plan.deliveredChanged.length > 0) {
    lines.push(
      `${plural(plan.deliveredChanged.length, "changed document")} ${plan.deliveredChanged.length === 1 ? "was" : "were"} ` +
        "already delivered to the supplier.",
    );
  }
  return lines.join(" ");
}

export function rerunApprovedSummaryText(input: { plan: ApprovedRerunPlan; rerun: RerunOutcome | null }): string {
  const { plan, rerun } = input;
  const lines: string[] = [];
  if (plan.rerunRows.length === 0) {
    lines.push("No approved documents needed sending back to review.");
  } else {
    lines.push(
      `${plural(plan.rerunRows.length, "approved document")} sent back to review; ` +
        "delivery happens only when someone approves them again.",
    );
    const skipped = skippedByEnqueue(rerun);
    if (skipped) lines.push(skipped);
  }
  if (plan.skippedInFlight.length > 0) {
    lines.push(`${plural(plan.skippedInFlight.length, "document")} skipped because a run is in progress for its style.`);
  }
  return lines.join(" ");
}

// 1..REJECT_REASON_MAX characters once trimmed.
export function normaliseRejectReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new PublishInputError("Say why the change is rejected");
  if (text.length > REJECT_REASON_MAX) {
    throw new PublishInputError(`Keep the reason under ${REJECT_REASON_MAX} characters`);
  }
  return text;
}

// ── In-process lock ──────────────────────────────────────────────────────────
// One approve / reject / rerun per output at a time: a double click must not
// publish once and enqueue twice. On globalThis so a dev hot reload keeps it.
const g = globalThis as typeof globalThis & { __changeRequestPublishing?: Set<string> };
const busy: Set<string> = (g.__changeRequestPublishing ??= new Set<string>());

async function withOutputLock<T>(outputId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(outputId)) {
    throw new OutputStateError("Another approve or reject of this output is still running; wait a moment and reload");
  }
  busy.add(outputId);
  try {
    return await fn();
  } finally {
    busy.delete(outputId);
  }
}

// ── Helpers (DB) ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusWords(status: string): string {
  return status.toLowerCase().replace(/_/g, " ");
}

async function loadOutput(outputId: string) {
  const output = await getOutputWithRequest(outputId);
  if (!output) throw new OutputNotFoundError(outputId);
  return output;
}

// styleId → prodSpecId for the styles about to be rerun.
async function styleProdSpecs(styleIds: readonly string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(styleIds)];
  if (ids.length === 0) return new Map();
  const styles = await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, prodSpecId: true } });
  return new Map(styles.map((s) => [s.id, s.prodSpecId]));
}

function changedStyleIds(rows: readonly ImpactRow[]): string[] {
  return [...new Set(rows.filter((r) => r.changed).map((r) => r.styleId))];
}

// Before/after of the output's own style for the "live" email. Fail-soft: no
// pictures is better than no email.
async function liveProofs(revisionId: string, styleId: string | null): Promise<{ beforePng?: Buffer; afterPng?: Buffer }> {
  if (!styleId) return {};
  try {
    const [before, after] = await Promise.all([
      renderProof({ revisionId, styleId, side: "before" }),
      renderProof({ revisionId, styleId, side: "after" }),
    ]);
    return { beforePng: before.png, afterPng: after.png };
  } catch (err) {
    console.warn(`[change-requests] proofs for the live email of revision ${revisionId} skipped: ${errorMessage(err)}`);
    return {};
  }
}

// Bookkeeping notes after the state change; a failure here must not turn a
// done publish or reject into an error.
async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[change-requests] ${what} failed: ${errorMessage(err)}`);
  }
}

// ── Approve ──────────────────────────────────────────────────────────────────

export type ApproveOptions = {
  userId: string;
  // For the rerun batch's "started by"; null when unknown.
  userEmail?: string | null;
  // Publish over a conflict (the live layout moved since the draft was made).
  force?: boolean;
};

export type ApproveResult = {
  revisionId: string;
  publishedVersion: number;
  // A conflict was overridden by `force`.
  forced: boolean;
  rerun: RerunOutcome & {
    // Changed documents the jobs regenerate.
    documents: number;
    skippedInFlight: number;
    error: string | null;
  };
  approvedChanged: ImpactRow[];
  deliveredChanged: ImpactRow[];
  heldByApproved: ImpactRow[];
  // The fresh impact could not be computed (nothing was rerun).
  impactError: string | null;
  // The SYSTEM message posted to the thread.
  summary: string;
};

export async function approveOutput(outputId: string, opts: ApproveOptions): Promise<ApproveResult> {
  return withOutputLock(outputId, async () => {
    const output = await loadOutput(outputId);
    if (output.status !== "IN_REVIEW") {
      throw new OutputStateError(
        `This output is ${statusWords(output.status)}; only a draft in review can be approved`,
        output.status,
      );
    }
    if (!output.currentRevisionId) {
      throw new OutputStateError("There is no draft to approve yet", output.status);
    }
    const revision = await getRevision(output.currentRevisionId);
    if (!revision) throw new OutputStateError("The draft could not be found; ask the agent for a new draft", output.status);
    if (revision.status === ("SUPERSEDED" satisfies RevisionStatus) || revision.status === ("DISCARDED" satisfies RevisionStatus)) {
      throw new OutputStateError(REPLACED_DRAFT_MESSAGE, output.status);
    }

    // ── Publish (or find it already published) ──
    let published: RevisionRow;
    let publishedVersion: number;
    let forced = false;
    let before: unknown = revision.baseDefinition;
    if (revision.status === ("PUBLISHED" satisfies RevisionStatus)) {
      // An earlier approval published it and died, or it was published from
      // the layout's History panel: finish the bookkeeping.
      published = revision;
      publishedVersion =
        revision.publishedVersion ??
        (await db.outputLayout.findUnique({ where: { id: revision.layoutId }, select: { version: true } }))?.version ??
        revision.baseVersion + 1;
    } else {
      // Only a forced publish can have something other than the base live
      // just before it; read it so the impact compares what really changed.
      const liveBefore = opts.force
        ? await db.outputLayout.findUnique({ where: { id: revision.layoutId }, select: { definition: true } })
        : null;
      const result = await publishRevision(revision.id, { userId: opts.userId, force: opts.force });
      published = result.revision;
      publishedVersion = result.publishedVersion;
      forced = result.overrodeConflict !== null;
      if (forced && liveBefore) before = liveBefore.definition;
    }

    // ── Fresh impact: before → published ──
    let impact: ImpactSummary | null = null;
    let impactError: string | null = null;
    try {
      impact = await computeImpact({
        layoutId: revision.layoutId,
        proposedDef: parseLayoutDef(published.definition),
        currentDef: parseLayoutDef(before),
      });
    } catch (err) {
      impactError = errorMessage(err);
      console.error(`[change-requests] impact after publishing revision ${revision.id} failed: ${impactError}`);
    }

    // ── Scoped rerun ──
    let plan: ScopedRerunPlan | null = null;
    let rerun: RerunOutcome | null = null;
    let rerunError: string | null = null;
    if (impact) {
      try {
        plan = planScopedRerun(impact.rows, await styleProdSpecs(changedStyleIds(impact.rows)));
        if (plan.runnable.length > 0) {
          rerun = await enqueueBulkRun({
            runnable: plan.runnable,
            label: `${requestRef(output.request.number)} · ${output.label}`,
            user: { id: opts.userId, email: opts.userEmail ?? null },
            triggerSource: "CHANGE_REQUEST",
          });
        }
      } catch (err) {
        rerunError = errorMessage(err);
        console.error(`[change-requests] rerun after publishing revision ${revision.id} failed: ${rerunError}`);
        plan ??= planScopedRerun(impact.rows, new Map());
      }
    }

    // ── The output is live ──
    const now = new Date();
    await setOutputStatus(outputId, "PUBLISHED", {
      approvedById: opts.userId,
      approvedAt: now,
      publishedAt: now,
      firstTryApproved: output.draftCount === 1,
      ...(impact ? { impact: impact as unknown as Prisma.InputJsonValue } : {}),
    });

    const summary = publishSummaryText({ publishedVersion, forced, plan, rerun, impactError, rerunError });
    const rerunOut: ApproveResult["rerun"] = {
      enqueued: rerun?.enqueued ?? 0,
      batchId: rerun?.batchId ?? null,
      skippedNoPo: rerun?.skippedNoPo ?? 0,
      skippedBelowCutoff: rerun?.skippedBelowCutoff ?? 0,
      documents: rerunError ? 0 : (plan?.rerunRows.length ?? 0),
      skippedInFlight: plan?.skippedInFlight.length ?? 0,
      error: rerunError,
    };
    await quietly("the published note", () =>
      appendMessage({
        requestId: output.requestId,
        outputId,
        authorKind: "SYSTEM",
        authorUserId: opts.userId,
        kind: "status",
        body: summary,
        revisionId: revision.id,
        meta: {
          event: "published",
          publishedVersion,
          forced,
          rerun: rerunOut,
          approvedChanged: plan?.approvedChanged.length ?? 0,
          deliveredChanged: plan?.deliveredChanged.length ?? 0,
          heldByApproved: plan?.heldByApproved.length ?? 0,
          impactError,
        },
      }),
    );

    // Same rule as the "received" email: the requester is written to when a
    // reviewer filed it; an admin filing for themselves knows already.
    if (output.request.source === "REQUESTER") {
      const proofs = await liveProofs(revision.id, output.styleId);
      await sendRequesterUpdate(output.requestId, "live", { outputId, ...proofs });
    }

    return {
      revisionId: revision.id,
      publishedVersion,
      forced,
      rerun: rerunOut,
      approvedChanged: plan?.approvedChanged ?? [],
      deliveredChanged: plan?.deliveredChanged ?? [],
      heldByApproved: plan?.heldByApproved ?? [],
      impactError,
      summary,
    };
  });
}

// ── Rerun approved documents (the second confirmation) ───────────────────────

export type RerunApprovedOptions = {
  userId: string;
  userEmail?: string | null;
  // Only these styles; all approved changed documents when absent.
  styleIds?: readonly string[] | null;
};

export type RerunApprovedResult = RerunOutcome & {
  documents: number;
  skippedInFlight: number;
  alreadyCurrent: number;
  rows: ImpactRow[];
  summary: string;
};

export async function rerunApprovedDocuments(outputId: string, opts: RerunApprovedOptions): Promise<RerunApprovedResult> {
  return withOutputLock(outputId, async () => {
    const output = await loadOutput(outputId);
    if (output.status !== "PUBLISHED") {
      throw new OutputStateError(
        `This output is ${statusWords(output.status)}; approved documents are sent back only after the change is live`,
        output.status,
      );
    }
    const revision = output.currentRevisionId ? await getRevision(output.currentRevisionId) : null;
    if (!revision || revision.status !== ("PUBLISHED" satisfies RevisionStatus)) {
      throw new OutputStateError("The published draft of this output could not be found", output.status);
    }

    // Recomputed now, not read from the output: review states moved on since
    // the approval. Errors (too many styles) surface — nothing was done yet.
    const impact = await computeImpact({
      layoutId: revision.layoutId,
      proposedDef: parseLayoutDef(revision.definition),
      currentDef: parseLayoutDef(revision.baseDefinition),
    });

    // A document regenerated after the publish already prints the new layout.
    const candidates = impact.rows.filter((r) => r.changed && r.reviewStatus === "APPROVED");
    const regenerated = new Set<string>();
    const since = revision.publishedAt ?? output.publishedAt;
    if (since && candidates.length > 0) {
      const current = await getCurrentOutputsForStyles([...new Set(candidates.map((r) => r.styleId))]);
      for (const [styleId, outputs] of current) {
        for (const o of outputs) {
          if (o.generatedAt && o.generatedAt.getTime() > since.getTime()) regenerated.add(docRef(styleId, o.variantKey));
        }
      }
    }

    const plan = planApprovedRerun(impact.rows, {
      styleProdSpec: await styleProdSpecs(candidates.map((r) => r.styleId)),
      styleIds: opts.styleIds ?? null,
      regenerated,
    });

    let rerun: RerunOutcome | null = null;
    if (plan.runnable.length > 0) {
      rerun = await enqueueBulkRun({
        runnable: plan.runnable,
        label: `${requestRef(output.request.number)} · ${output.label} · approved`,
        user: { id: opts.userId, email: opts.userEmail ?? null },
        // The one change-request run the runner lets regenerate approved
        // documents (runKeepsApprovedDocuments).
        triggerSource: "CHANGE_REQUEST_APPROVED",
      });
    }

    const summary = rerunApprovedSummaryText({ plan, rerun });
    if (plan.runnable.length > 0) {
      await quietly("the rerun note", () =>
        appendMessage({
          requestId: output.requestId,
          outputId,
          authorKind: "SYSTEM",
          authorUserId: opts.userId,
          kind: "status",
          body: summary,
          revisionId: revision.id,
          meta: {
            event: "rerun_approved",
            enqueued: rerun?.enqueued ?? 0,
            batchId: rerun?.batchId ?? null,
            documents: plan.rerunRows.length,
            styleIds: plan.runnable.map((r) => r.id),
          },
        }),
      );
    }

    return {
      enqueued: rerun?.enqueued ?? 0,
      batchId: rerun?.batchId ?? null,
      skippedNoPo: rerun?.skippedNoPo ?? 0,
      skippedBelowCutoff: rerun?.skippedBelowCutoff ?? 0,
      documents: plan.rerunRows.length,
      skippedInFlight: plan.skippedInFlight.length,
      alreadyCurrent: plan.alreadyCurrent.length,
      rows: plan.rerunRows,
      summary,
    };
  });
}

// ── Reject ───────────────────────────────────────────────────────────────────

// Settled outputs can't be rejected; a WORKING one waits for its run (which
// would otherwise leave a fresh draft behind the rejection).
const NOT_REJECTABLE: ReadonlySet<string> = new Set(["PUBLISHED", "REJECTED", "APPROVED", "WORKING"]);

export type RejectResult = { discarded: number; reason: string };

export async function rejectOutput(outputId: string, opts: { userId: string; reason: unknown }): Promise<RejectResult> {
  const reason = normaliseRejectReason(opts.reason);
  return withOutputLock(outputId, async () => {
    const output = await loadOutput(outputId);
    if (NOT_REJECTABLE.has(output.status)) {
      throw new OutputStateError(
        output.status === "WORKING"
          ? "The agent is working on this output; wait for the run to finish, then reject"
          : `This output is ${statusWords(output.status)} and can't be rejected`,
        output.status,
      );
    }

    // The current draft must not be live already (published from the
    // layout's History panel): rejecting would claim nothing changed.
    const current = output.currentRevisionId ? await getRevision(output.currentRevisionId) : null;
    if (current?.status === ("PUBLISHED" satisfies RevisionStatus)) {
      throw new OutputStateError(
        "This draft is already live; approve it to finish, or restore the earlier version from the layout's history",
        output.status,
      );
    }

    // Every open draft of this output goes, the current one first: older
    // drafts left open would sit in the Output Builder's notice forever.
    const others = await orEmpty(
      db.outputLayoutRevision.findMany({
        where: { changeRequestOutputId: outputId, status: "DRAFT" satisfies RevisionStatus },
        select: { id: true },
      }),
      [] as { id: string }[],
    );
    const open = [
      ...(current?.status === ("DRAFT" satisfies RevisionStatus) ? [current.id] : []),
      ...others.map((r) => r.id).filter((id) => id !== current?.id),
    ];
    let discarded = 0;
    for (const id of open) {
      try {
        await discardDraft(id);
        discarded++;
      } catch (err) {
        if (!(err instanceof RevisionStateError)) throw err;
        // Published a moment ago: that is a live change, not something to
        // reject. Any other draft that moved on is simply no longer open.
        if (id === current?.id) {
          throw new OutputStateError(
            "This draft was published while you were rejecting it; reload the request",
            output.status,
          );
        }
      }
    }

    await setOutputStatus(outputId, "REJECTED", { rejectReason: reason });
    await quietly("the rejected note", () =>
      appendMessage({
        requestId: output.requestId,
        outputId,
        authorKind: "SYSTEM",
        authorUserId: opts.userId,
        kind: "status",
        body: `Rejected; the layout stays as it is. Reason: ${reason}`,
        revisionId: current?.id ?? null,
        meta: { event: "rejected", reason, discarded },
      }),
    );
    if (output.request.source === "REQUESTER") {
      await sendRequesterUpdate(output.requestId, "rejected", { outputId, message: reason });
    }
    return { discarded, reason };
  });
}
