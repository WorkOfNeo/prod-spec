// =====================================================
// Change requests — learning signals (design docs/plans/change-requests.md §5.9).
//
// How well is the agent doing? One row per ChangeRequestOutput, built only
// from records the feature already writes — no extra bookkeeping on the hot
// path:
//
//   • drafts + first-try approval come from the output row itself
//     (draftCount, firstTryApproved — stamped by approveOutput);
//   • what the reviewer had to ask for comes from the revision chain: every
//     revision with a parent is a reviewer-driven redo, and the diff between
//     parent and child (describeLayoutChanges, the same diff the review screen
//     shows) is bucketed into a few edit kinds — size, position, wording,
//     scope, other;
//   • cost is the sum of the output's agent steps (ChangeRequestStep.costUsd).
//
// The /requests table and the bench read the same rows, so a change in the
// numbers is a change in behaviour, not in counting. Bucketing and totals are
// pure and exported; outputSignals() is the only DB-touching function and
// reads fail-soft while the tables aren't deployed.
// =====================================================

import { db } from "@/lib/db";
import { describeLayoutChanges, type LayoutChange } from "@/lib/output-layouts/ops";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { orEmpty } from "./db-safe";
import { requestRef } from "./types";

export const EDIT_KINDS = ["size", "position", "wording", "scope", "other"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export type OutputSignalRow = {
  outputId: string;
  requestId: string;
  requestNumber: number;
  requestRef: string;
  label: string;
  status: string;
  draftCount: number;
  firstTryApproved: boolean | null;
  editKinds: EditKind[];
  timeToApprovalMs: number | null;
  costUsd: number;
  rejectReason: string | null;
  createdAt: string; // ISO — rows cross the server/client boundary as plain JSON
};

export type SignalTotals = {
  requests: number;
  outputs: number;
  // Share of decided outputs (firstTryApproved set) approved on the first
  // draft; null until anything has been approved.
  firstTryRate: number | null;
  // Median drafts over outputs that got at least one draft.
  medianDrafts: number | null;
  totalCostUsd: number;
};

// ---------- edit kinds (pure) ----------

// One described change → the kind of correction it represents. Font size is
// told apart from the other block props by describeLayoutChanges' own wording
// ("Font 7 → 8 pt on block …"), which signals.test.ts pins.
export function editKindOf(change: LayoutChange): EditKind {
  switch (change.kind) {
    case "props":
      return change.summary.startsWith("Font ") ? "size" : "other";
    case "move":
    case "resize":
      return "position";
    case "text":
      return "wording";
    case "add_block":
    case "remove_block":
      return "scope";
    default:
      return "other";
  }
}

// Distinct kinds, always in EDIT_KINDS order so rows compare and render stably.
export function sortEditKinds(kinds: Iterable<EditKind>): EditKind[] {
  const seen = new Set(kinds);
  return EDIT_KINDS.filter((k) => seen.has(k));
}

function looksLikeDef(v: unknown): v is LayoutDef {
  return !!v && typeof v === "object" && Array.isArray((v as { pages?: unknown }).pages);
}

// The kinds of change between two stored definitions. Anything that isn't a
// layout definition (or that the diff can't read) contributes nothing rather
// than failing the whole table.
export function editKindsBetween(before: unknown, after: unknown): EditKind[] {
  if (!looksLikeDef(before) || !looksLikeDef(after)) return [];
  try {
    return sortEditKinds(describeLayoutChanges(before, after).map(editKindOf));
  } catch {
    return [];
  }
}

export type RevisionForSignals = { id: string; parentRevisionId: string | null; definition: unknown };

// Union of edit kinds over an output's revisions. Only revisions with a parent
// count (the first draft is the agent's own reading, not a correction).
// `definitions` resolves a parent id to its definition — parents usually sit
// in the same list, but may belong to another output.
export function outputEditKinds(
  revisions: readonly RevisionForSignals[],
  definitions: ReadonlyMap<string, unknown>,
): EditKind[] {
  const kinds: EditKind[] = [];
  for (const rev of revisions) {
    if (!rev.parentRevisionId || !definitions.has(rev.parentRevisionId)) continue;
    kinds.push(...editKindsBetween(definitions.get(rev.parentRevisionId), rev.definition));
  }
  return sortEditKinds(kinds);
}

// ---------- rows + totals (pure) ----------

export type OutputForSignals = {
  id: string;
  requestId: string;
  label: string;
  status: string;
  draftCount: number;
  firstTryApproved: boolean | null;
  approvedAt: Date | null;
  createdAt: Date;
  rejectReason: string | null;
  request: { number: number };
};

export function buildOutputSignal(output: OutputForSignals, editKinds: EditKind[], costUsd: number): OutputSignalRow {
  const elapsed = output.approvedAt ? output.approvedAt.getTime() - output.createdAt.getTime() : null;
  return {
    outputId: output.id,
    requestId: output.requestId,
    requestNumber: output.request.number,
    requestRef: requestRef(output.request.number),
    label: output.label,
    status: output.status,
    draftCount: output.draftCount,
    firstTryApproved: output.firstTryApproved,
    editKinds,
    timeToApprovalMs: elapsed != null && elapsed >= 0 ? elapsed : null,
    costUsd: roundUsd(costUsd),
    rejectReason: output.rejectReason,
    createdAt: output.createdAt.toISOString(),
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function signalTotals(rows: readonly OutputSignalRow[]): SignalTotals {
  const decided = rows.filter((r) => r.firstTryApproved !== null);
  return {
    requests: new Set(rows.map((r) => r.requestId)).size,
    outputs: rows.length,
    firstTryRate: decided.length ? decided.filter((r) => r.firstTryApproved).length / decided.length : null,
    medianDrafts: median(rows.filter((r) => r.draftCount > 0).map((r) => r.draftCount)),
    totalCostUsd: roundUsd(rows.reduce((sum, r) => sum + r.costUsd, 0)),
  };
}

// Float sums of per-step costs drift (0.1 + 0.2); a micro-dollar is plenty.
function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------- loader ----------

const TAKE_MAX = 200;

// The newest outputs (default 50), with their revisions and step costs.
export async function outputSignals({ take = 50 }: { take?: number } = {}): Promise<OutputSignalRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(take) || 1), TAKE_MAX);
  const outputs = await orEmpty(
    db.changeRequestOutput.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        requestId: true,
        label: true,
        status: true,
        draftCount: true,
        firstTryApproved: true,
        approvedAt: true,
        createdAt: true,
        rejectReason: true,
        request: { select: { number: true } },
      },
    }),
    [],
  );
  if (outputs.length === 0) return [];
  const ids = outputs.map((o) => o.id);

  const [revisions, costs] = await Promise.all([
    orEmpty(
      db.outputLayoutRevision.findMany({
        where: { changeRequestOutputId: { in: ids } },
        orderBy: { createdAt: "asc" },
        select: { id: true, changeRequestOutputId: true, parentRevisionId: true, definition: true },
      }),
      [],
    ),
    orEmpty(
      db.changeRequestStep.groupBy({
        by: ["outputId"],
        where: { outputId: { in: ids } },
        _sum: { costUsd: true },
      }),
      [],
    ),
  ]);

  // Parents outside this set (rare: a draft revised from another output's).
  const definitions = new Map<string, unknown>(revisions.map((r) => [r.id, r.definition]));
  const missing = [
    ...new Set(revisions.map((r) => r.parentRevisionId).filter((p): p is string => !!p && !definitions.has(p))),
  ];
  if (missing.length) {
    const parents = await orEmpty(
      db.outputLayoutRevision.findMany({ where: { id: { in: missing } }, select: { id: true, definition: true } }),
      [],
    );
    for (const p of parents) definitions.set(p.id, p.definition);
  }

  const byOutput = new Map<string, RevisionForSignals[]>();
  for (const r of revisions) {
    if (!r.changeRequestOutputId) continue;
    const list = byOutput.get(r.changeRequestOutputId) ?? [];
    list.push(r);
    byOutput.set(r.changeRequestOutputId, list);
  }
  const costByOutput = new Map(costs.map((c) => [c.outputId, c._sum.costUsd ?? 0]));

  return outputs.map((o) =>
    buildOutputSignal(o, outputEditKinds(byOutput.get(o.id) ?? [], definitions), costByOutput.get(o.id) ?? 0),
  );
}
