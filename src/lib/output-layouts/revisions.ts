import { db } from "@/lib/db";
import type { OutputLayoutRevision, Prisma } from "@/generated/prisma/client";
import { orEmpty } from "@/lib/change-requests/db-safe";
import type { RevisionAuthorKind, RevisionStatus } from "@/lib/change-requests/types";
import { LayoutDefSchema, parseLayoutDef, type LayoutDef } from "./schema";
import { validateLayoutForPublish } from "./publish-validation";
import { refreshLayoutVariants } from "./variants";

// =====================================================
// Layout revisions — drafts and publish history for an OutputLayout
// (design docs/plans/change-requests.md §5.1). SERVER-ONLY (imports db).
//
// The contract, in order of importance:
//
//   1. A draft never changes what prints. createDraft/reviseDraft only insert
//      revision rows; publishRevision() is the ONLY function here that writes
//      OutputLayout.definition, and only admin-initiated routes call it.
//
//   2. A publish never silently overwrites someone else's work. A draft records
//      the live definition + version it was made from (baseDefinition /
//      baseVersion). The Output Builder autosaves straight onto the live row
//      WITHOUT bumping version, so the version alone can't see a builder edit:
//      publish compares both and refuses with RevisionConflictError unless the
//      admin explicitly forces it. The same check is repeated as a guard on the
//      UPDATE itself, so an autosave landing between the check and the write
//      can't slip through either.
//
//   3. History only moves forward. Publishing bumps OutputLayout.version — the
//      bump is what makes classifyOutput() see pending documents as changed —
//      and a restore is a NEW draft that is published, never a rewind of rows.
//
// The Output Builder autosave and its own Publish button are unchanged; both
// publish paths share validateLayoutForPublish().
//
// Decision logic is pure and exported (nextRevisionNumber, definitionsEqual,
// detectConflict, describeConflict, parseDraftDefinition, restorableDefinition)
// so it is tested without a database; the functions below only orchestrate.
// Readers degrade to empty on a not-yet-deployed table (db-safe.ts).
// =====================================================

export type RevisionRow = OutputLayoutRevision;
// List/notice shape: the two definition blobs left out (a layout's history can
// run to dozens of full definitions). getRevision() returns the full row.
export type RevisionSummary = Omit<OutputLayoutRevision, "definition" | "baseDefinition">;

const SUMMARY_OMIT = { definition: true, baseDefinition: true } as const;

// ── Errors ───────────────────────────────────────────────────────────────────
// Each carries the HTTP status a route should answer with.

export class RevisionNotFoundError extends Error {
  readonly httpStatus = 404;
  constructor(
    readonly what: "revision" | "layout",
    readonly id: string,
  ) {
    super(what === "layout" ? "Layout not found" : "Revision not found");
    this.name = "RevisionNotFoundError";
  }
}

// The revision isn't in a state that allows the action (publishing a
// non-draft, discarding a published revision, restoring a never-published
// draft's definition).
export class RevisionStateError extends Error {
  readonly httpStatus = 409;
  constructor(
    readonly revisionId: string,
    readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = "RevisionStateError";
  }
}

// The live layout moved since the draft was made. `conflict` says what moved.
export class RevisionConflictError extends Error {
  readonly httpStatus = 409;
  constructor(readonly conflict: RevisionConflict) {
    super(describeConflict(conflict));
    this.name = "RevisionConflictError";
  }
}

// The definition fails the schema (draft) or the strict publish gate
// (validateLayoutForPublish). `message` + `details` map onto the publish
// route's existing { error, details } 422 body.
export class RevisionValidationError extends Error {
  readonly httpStatus = 422;
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = "RevisionValidationError";
  }
}

// ── Pure decision logic ──────────────────────────────────────────────────────

export function nextRevisionNumber(currentMax: number | null | undefined): number {
  return (currentMax ?? 0) + 1;
}

// Structural equality of two JSON values: object key order is irrelevant
// (JSONB reorders keys anyway), array order matters, and a key holding
// `undefined` counts as absent — exactly what JSON serialisation does.
export function definitionsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => definitionsEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && definitionsEqual(ao[k], bo[k]));
}

export type RevisionConflict = {
  baseVersion: number;
  liveVersion: number;
  // Published again since the draft (Builder Publish button or another
  // revision).
  versionChanged: boolean;
  // Live definition no longer equals the draft's base — typically a builder
  // autosave, which does not bump version.
  definitionChanged: boolean;
};

export function detectConflict(
  liveDef: unknown,
  liveVersion: number,
  revision: { baseDefinition: unknown; baseVersion: number },
): RevisionConflict | null {
  const versionChanged = liveVersion !== revision.baseVersion;
  const definitionChanged = !definitionsEqual(liveDef, revision.baseDefinition);
  if (!versionChanged && !definitionChanged) return null;
  return { baseVersion: revision.baseVersion, liveVersion, versionChanged, definitionChanged };
}

export function describeConflict(c: RevisionConflict): string {
  const what =
    c.versionChanged && c.definitionChanged
      ? `the layout was published again (version ${c.baseVersion} → ${c.liveVersion}) and its definition changed`
      : c.versionChanged
        ? `the layout was published again (version ${c.baseVersion} → ${c.liveVersion})`
        : "the layout was edited in the Output Builder";
  return (
    `Can't publish: ${what} since this draft was made. ` +
    "Make a new draft from the current layout, or publish anyway to overwrite those changes."
  );
}

// A draft's definition must be a real layout. parseLayoutDef() alone would
// turn garbage ({} / null / a string) into the STARTER layout — fine for
// opening an old row in the editor, never for a draft someone might publish.
// So the shape is checked strictly first, then parseLayoutDef normalises it
// (block ids, legacy margins/padding/anchors) so ops can address blocks by id.
export function parseDraftDefinition(
  raw: unknown,
): { ok: true; def: LayoutDef } | { ok: false; error: string; details: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("pages" in raw)) {
    return {
      ok: false,
      error: "Draft definition is invalid",
      details: ["definition must be a layout object with pages"],
    };
  }
  const parsed = LayoutDefSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Draft definition is invalid", details: parsed.error.issues.map((i) => i.message) };
  }
  return { ok: true, def: parseLayoutDef(raw) };
}

export type RestoreWhich = "definition" | "base";

// What a restore would put live. "base" = what was live when that revision was
// drafted ("restore what was live before") — always something that printed.
// "definition" = the revision's own definition, allowed only for a revision
// that was PUBLISHED: restoring an unpublished draft would put it live without
// the review (impact, proofs, approval) a draft exists to get.
export function restorableDefinition(
  revision: { number: number; status: string; definition: unknown; baseDefinition: unknown },
  which: RestoreWhich,
): { ok: true; definition: unknown } | { ok: false; reason: string } {
  if (which === "base") return { ok: true, definition: revision.baseDefinition };
  if (revision.status !== ("PUBLISHED" satisfies RevisionStatus)) {
    return {
      ok: false,
      reason: `Revision #${revision.number} was never published — review and publish the draft instead of restoring it`,
    };
  }
  return { ok: true, definition: revision.definition };
}

function restoreNote(number: number, which: RestoreWhich): string {
  return which === "base"
    ? `Restore: what was live before revision #${number}`
    : `Restore: revision #${number}`;
}

// ── Prisma error shapes (duck-typed so mocks can throw plain { code }) ──────
function hasCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === code;
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export type CreateDraftInput = {
  layoutId: string;
  definition: unknown;
  authorKind: RevisionAuthorKind;
  authorUserId?: string | null;
  changeRequestOutputId?: string | null;
  parentRevisionId?: string | null;
  // LayoutOp[] that produced it (ops.ts owns the type; stored opaque).
  ops?: unknown[] | null;
  note?: string | null;
};

// Snapshot the live layout as the base and insert the next-numbered DRAFT.
// Two drafts racing for the same number hit the (layoutId, number) unique
// index; the loser re-reads and takes the next one.
export async function createDraft(input: CreateDraftInput): Promise<RevisionRow> {
  const parsed = parseDraftDefinition(input.definition);
  if (!parsed.ok) throw new RevisionValidationError(parsed.error, parsed.details);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const layout = await db.outputLayout.findUnique({
      where: { id: input.layoutId },
      select: { id: true, definition: true, version: true },
    });
    if (!layout) throw new RevisionNotFoundError("layout", input.layoutId);
    const last = await db.outputLayoutRevision.findFirst({
      where: { layoutId: layout.id },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    try {
      return await db.outputLayoutRevision.create({
        data: {
          layoutId: layout.id,
          number: nextRevisionNumber(last?.number),
          status: "DRAFT" satisfies RevisionStatus,
          definition: parsed.def as unknown as Prisma.InputJsonValue,
          // Stored exactly as read: the conflict check compares it with the
          // live column verbatim, and a restore of "base" brings back what
          // actually printed.
          baseDefinition: layout.definition as Prisma.InputJsonValue,
          baseVersion: layout.version,
          authorKind: input.authorKind,
          authorUserId: input.authorUserId ?? null,
          changeRequestOutputId: input.changeRequestOutputId ?? null,
          parentRevisionId: input.parentRevisionId ?? null,
          ...(input.ops ? { ops: input.ops as Prisma.InputJsonValue } : {}),
          note: input.note ?? null,
        },
      });
    } catch (err) {
      if (hasCode(err, "P2002") && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

// A new draft that revises an earlier one (a reviewer comment → the agent's
// next attempt). Same layout as the parent; the base is re-snapshotted from
// the live layout NOW, so the conflict check is against today's layout. The
// parent is left as it is — the reviewer may still prefer it.
export async function reviseDraft(
  parentRevisionId: string,
  input: Omit<CreateDraftInput, "layoutId" | "parentRevisionId">,
): Promise<RevisionRow> {
  const parent = await db.outputLayoutRevision.findUnique({
    where: { id: parentRevisionId },
    select: { id: true, layoutId: true, changeRequestOutputId: true },
  });
  if (!parent) throw new RevisionNotFoundError("revision", parentRevisionId);
  return createDraft({
    ...input,
    layoutId: parent.layoutId,
    parentRevisionId: parent.id,
    changeRequestOutputId: input.changeRequestOutputId ?? parent.changeRequestOutputId,
  });
}

// ── Readers (degrade to empty before the migration is deployed) ──────────────

export async function getRevision(revisionId: string): Promise<RevisionRow | null> {
  return orEmpty(db.outputLayoutRevision.findUnique({ where: { id: revisionId } }), null);
}

// Newest first.
export async function listRevisions(layoutId: string): Promise<RevisionSummary[]> {
  return orEmpty(
    db.outputLayoutRevision.findMany({
      where: { layoutId },
      orderBy: { number: "desc" },
      omit: SUMMARY_OMIT,
    }),
    [],
  );
}

// The newest open draft for a layout — drives the Output Builder's "a draft is
// waiting" notice. null when there is none (or the table isn't there yet).
export async function openDraftFor(layoutId: string): Promise<RevisionSummary | null> {
  return orEmpty(
    db.outputLayoutRevision.findFirst({
      where: { layoutId, status: "DRAFT" satisfies RevisionStatus },
      orderBy: { number: "desc" },
      omit: SUMMARY_OMIT,
    }),
    null,
  );
}

// ── State changes ────────────────────────────────────────────────────────────

// DRAFT → DISCARDED. Conditional update, so a draft published a moment ago is
// never flipped to discarded behind the publisher's back.
export async function discardDraft(revisionId: string): Promise<void> {
  const res = await db.outputLayoutRevision.updateMany({
    where: { id: revisionId, status: "DRAFT" satisfies RevisionStatus },
    data: { status: "DISCARDED" satisfies RevisionStatus },
  });
  if (res.count > 0) return;
  const rev = await db.outputLayoutRevision.findUnique({
    where: { id: revisionId },
    select: { number: true, status: true },
  });
  if (!rev) throw new RevisionNotFoundError("revision", revisionId);
  throw new RevisionStateError(
    revisionId,
    rev.status,
    `Revision #${rev.number} is ${rev.status.toLowerCase()} — only a draft can be discarded`,
  );
}

export type PublishRevisionResult = {
  revision: RevisionRow;
  layout: { id: string; status: string; version: number };
  // OutputLayout.version after the publish (also on the revision row).
  publishedVersion: number;
  // Other open drafts of the layout marked SUPERSEDED.
  superseded: number;
  // Set when `force` overrode a conflict: what was overwritten.
  overrodeConflict: RevisionConflict | null;
};

// Put a draft live. Order: state check → conflict check (unless force) →
// strict publish gate → ONE transaction (layout definition + PUBLISHED +
// version bump, revision PUBLISHED, other open drafts SUPERSEDED) → refresh
// the in-process variant registry so the next render uses the new definition.
export async function publishRevision(
  revisionId: string,
  opts: { userId: string; force?: boolean },
): Promise<PublishRevisionResult> {
  const revision = await db.outputLayoutRevision.findUnique({
    where: { id: revisionId },
    include: { layout: { select: { id: true, definition: true, version: true } } },
  });
  if (!revision) throw new RevisionNotFoundError("revision", revisionId);
  if (revision.status !== "DRAFT") {
    throw new RevisionStateError(
      revision.id,
      revision.status,
      `Revision #${revision.number} is ${revision.status.toLowerCase()} — only a draft can be published`,
    );
  }

  const live = revision.layout;
  const conflict = detectConflict(live.definition, live.version, revision);
  if (conflict && !opts.force) throw new RevisionConflictError(conflict);

  const validation = validateLayoutForPublish(revision.definition);
  if (!validation.ok) throw new RevisionValidationError(validation.error, validation.details);

  const result = await db.$transaction(async (tx) => {
    // Unforced, the write is guarded on exactly the state the check above
    // approved (version AND definition), so a builder autosave or publish that
    // lands in between makes the update match nothing instead of being lost.
    const where: Prisma.OutputLayoutWhereUniqueInput = opts.force
      ? { id: live.id }
      : { id: live.id, version: live.version, definition: { equals: live.definition as Prisma.InputJsonValue } };
    let layout: { id: string; status: string; version: number };
    try {
      layout = await tx.outputLayout.update({
        where,
        data: {
          definition: revision.definition as Prisma.InputJsonValue,
          status: "PUBLISHED",
          version: { increment: 1 },
        },
        select: { id: true, status: true, version: true },
      });
    } catch (err) {
      if (!hasCode(err, "P2025")) throw err;
      const now = await tx.outputLayout.findUnique({
        where: { id: live.id },
        select: { definition: true, version: true },
      });
      throw new RevisionConflictError(
        (now && detectConflict(now.definition, now.version, revision)) ?? {
          baseVersion: revision.baseVersion,
          liveVersion: now?.version ?? live.version,
          versionChanged: true,
          definitionChanged: true,
        },
      );
    }

    let published: RevisionRow;
    try {
      published = await tx.outputLayoutRevision.update({
        where: { id: revision.id, status: "DRAFT" satisfies RevisionStatus },
        data: {
          status: "PUBLISHED" satisfies RevisionStatus,
          publishedAt: new Date(),
          publishedById: opts.userId,
          publishedVersion: layout.version,
        },
      });
    } catch (err) {
      // Published or discarded by someone else between our read and now —
      // the throw rolls the layout write back with it.
      if (!hasCode(err, "P2025")) throw err;
      throw new RevisionStateError(revision.id, "unknown", `Revision #${revision.number} changed state meanwhile`);
    }

    const superseded = await tx.outputLayoutRevision.updateMany({
      where: { layoutId: live.id, status: "DRAFT" satisfies RevisionStatus, id: { not: revision.id } },
      data: { status: "SUPERSEDED" satisfies RevisionStatus },
    });

    return { revision: published, layout, superseded: superseded.count };
  });

  await refreshLayoutVariants();

  return {
    revision: result.revision,
    layout: result.layout,
    publishedVersion: result.layout.version,
    superseded: result.superseded,
    overrodeConflict: conflict,
  };
}

// Put an earlier state back live, moving history forward: a USER draft is made
// from the revision's definition ("definition", published revisions only) or
// from what was live before it ("base"), then published. If that publish
// fails — an old definition that no longer passes today's gate, or a builder
// edit landing in the same instant — the draft is discarded so no stray open
// draft is left behind, and the error is rethrown.
export async function restoreRevision(
  revisionId: string,
  opts: { userId: string; which: RestoreWhich },
): Promise<PublishRevisionResult> {
  const source = await db.outputLayoutRevision.findUnique({ where: { id: revisionId } });
  if (!source) throw new RevisionNotFoundError("revision", revisionId);
  const pick = restorableDefinition(source, opts.which);
  if (!pick.ok) throw new RevisionStateError(source.id, source.status, pick.reason);

  const draft = await createDraft({
    layoutId: source.layoutId,
    definition: pick.definition,
    authorKind: "USER",
    authorUserId: opts.userId,
    note: restoreNote(source.number, opts.which),
  });
  try {
    return await publishRevision(draft.id, { userId: opts.userId });
  } catch (err) {
    await db.outputLayoutRevision
      .updateMany({
        where: { id: draft.id, status: "DRAFT" satisfies RevisionStatus },
        data: { status: "DISCARDED" satisfies RevisionStatus },
      })
      .catch(() => {});
    throw err;
  }
}
