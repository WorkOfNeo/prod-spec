import type { RevisionStatus } from "@/lib/change-requests/types";
import type { RevisionSummary } from "./revisions";

// =====================================================
// Output Builder History panel — the serialisable view of a layout's
// revisions, and the rules for which actions a row offers (design §5.1).
//
// PURE and client-safe (type-only imports): the server page maps rows with
// toRevisionViews() (revision-history-db.ts loads them), the client panel
// reads the same types and asks rowActions() what to offer, so the two can't
// disagree about what a row can do.
// =====================================================

export type RevisionView = {
  id: string;
  number: number;
  status: string;
  authorKind: string;
  // "Agent", the author's email, or "Unknown user" (a deleted account).
  author: string;
  // Who published it, when that isn't the author (an agent draft an admin
  // approved). null when unpublished or self-published.
  publishedBy: string | null;
  note: string | null;
  createdAt: string; // ISO
  publishedAt: string | null; // ISO
  publishedVersion: number | null;
  baseVersion: number;
  changeRequestOutputId: string | null;
  // false for a snapshot row whose base IS its definition — the builder's own
  // Publish button (recordBuilderPublish): there is no distinct "before" to
  // compare with or restore.
  hasBefore: boolean;
};

export type OpenDraftView = {
  id: string;
  number: number;
  changeRequestOutputId: string | null;
  // The change request to link to; null when the draft isn't a change
  // request's, or its request couldn't be found.
  requestId: string | null;
};

export type LayoutHistoryData = {
  revisions: RevisionView[];
  openDraft: OpenDraftView | null;
};

const UNKNOWN_USER = "Unknown user";

// Every user id a list of revisions names (authors + publishers), once each.
export function revisionUserIds(rows: ReadonlyArray<Pick<RevisionSummary, "authorUserId" | "publishedById">>): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.authorUserId) ids.add(r.authorUserId);
    if (r.publishedById) ids.add(r.publishedById);
  }
  return [...ids];
}

export function toRevisionViews(
  rows: ReadonlyArray<RevisionSummary>,
  emailsById: ReadonlyMap<string, string>,
): RevisionView[] {
  const label = (id: string | null) => (id ? (emailsById.get(id) ?? UNKNOWN_USER) : UNKNOWN_USER);
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    authorKind: r.authorKind,
    author: r.authorKind === "AGENT" ? "Agent" : label(r.authorUserId),
    publishedBy: r.publishedById && r.publishedById !== r.authorUserId ? label(r.publishedById) : null,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    publishedVersion: r.publishedVersion,
    baseVersion: r.baseVersion,
    changeRequestOutputId: r.changeRequestOutputId,
    // A real publish always moves the version past the base; only a snapshot
    // records the version it published as its own base.
    hasBefore: r.publishedVersion === null || r.publishedVersion !== r.baseVersion,
  }));
}

export function toOpenDraftView(
  draft: Pick<RevisionSummary, "id" | "number" | "changeRequestOutputId">,
  requestId: string | null,
): OpenDraftView {
  return {
    id: draft.id,
    number: draft.number,
    changeRequestOutputId: draft.changeRequestOutputId,
    requestId: draft.changeRequestOutputId ? requestId : null,
  };
}

export type RowActions = {
  // List what the revision changes against what was live when it was made.
  compare: boolean;
  // Put this revision back live as it was published.
  restoreDefinition: boolean;
  // Put back what was live before this revision.
  restoreBase: boolean;
};

// Restores are offered on PUBLISHED rows only. Restoring a draft's own
// definition would put it live without the review a draft exists to get
// (restoreRevision refuses it too). "What was live before" a draft is offered
// nowhere: for an open draft it would publish over — and supersede — the very
// draft, and for a discarded or superseded one "before" names no event anyone
// would look for. Undoing a publish is the job; that's what's offered.
export function rowActions(row: Pick<RevisionView, "status" | "hasBefore">): RowActions {
  const published = row.status === ("PUBLISHED" satisfies RevisionStatus);
  return {
    compare: row.hasBefore,
    restoreDefinition: published,
    restoreBase: published && row.hasBefore,
  };
}
