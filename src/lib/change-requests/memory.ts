// =====================================================
// Change requests — agent memory (design docs/plans/change-requests.md §5.9).
//
// Corrections an admin makes in a review can become short notes the agent
// reads on its next run ("this customer wants quantities in bold"). The agent
// only ever PROPOSES a note (store.createProposedMemory, via its
// propose_memory tool); a person keeps it, edits it, dismisses it or forgets
// it, on the review thread or on /settings/agent-memory. Only KEPT notes ever
// reach a prompt, so nothing the agent wrote steers the next run until a
// person has read it.
//
// Lifecycle (every move is a compare-and-set on the current state, so two
// admins pressing Keep and Dismiss at once can't both win):
//
//   PROPOSED ──Keep──▶ KEPT ──Forget──▶ FORGOTTEN
//      │                ▲                   │
//   Dismiss             └──────Restore──────┘
//      ▼
//   DISMISSED ──Restore──▶ PROPOSED (back to a suggestion; Keep is also allowed)
//
// The "Follow along" log is derived from the rows themselves (newest
// updatedAt first), not from a separate event table: each note shows its
// latest event. Using a note in a prompt stamps lastUsedAt and updatedAt with
// the SAME instant, which is how the log tells "read by the agent" apart from
// a state change.
//
// Pure helpers (labels, grouping, prompt formatting, transition planning,
// event derivation) are exported and tested on their own; the DB functions
// are thin wrappers. Reads degrade to empty while the table isn't deployed
// (db-safe.ts); writes surface their errors.
// =====================================================

import { db } from "@/lib/db";
import type { AgentMemory, Prisma } from "@/generated/prisma/client";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { orEmpty } from "./db-safe";
import {
  MEMORY_SCOPES,
  MemoryScopeSchema,
  MemorySourceKindSchema,
  MemoryStateSchema,
  requestRef,
  type MemoryScope,
  type MemorySourceKind,
  type MemoryState,
} from "./types";

// Same cap createProposedMemory applies to agent text; a person's edit over
// it is refused rather than silently cut.
export const MEMORY_TEXT_MAX = 1000;
// Upper bound on notes appended to one prompt. Notes are curated by hand so
// this is a safety net, not a ranking: the most recently touched win.
export const PROMPT_NOTE_LIMIT = 60;
const LIST_LIMIT = 500;
const LOG_LIMIT_MAX = 200;

// ---------- labels (pure) ----------

// Chip / tag text on the settings page.
export const SCOPE_LABELS: Record<MemoryScope, string> = {
  GLOBAL: "Everywhere",
  CUSTOMER: "Customer",
  DOC_TYPE: "Doc type",
  MONDAY: "Monday data",
};

// Headings in the prompt block, written for the model.
const PROMPT_HEADINGS: Record<MemoryScope, string> = {
  GLOBAL: "Notes: general",
  CUSTOMER: "Notes: this customer",
  DOC_TYPE: "Notes: this document type",
  MONDAY: "Notes: Monday data",
};

export const STATE_LABELS: Record<MemoryState, string> = {
  PROPOSED: "Suggested",
  KEPT: "Kept",
  DISMISSED: "Dismissed",
  FORGOTTEN: "Forgotten",
};

// Where a note came from, in the reader's words.
export const SOURCE_KIND_LABELS: Record<MemorySourceKind, string> = {
  CORRECTION: "your correction",
  AGENT_FINDING: "the agent noticed",
  REQUEST: "from the request",
  MANUAL: "added by hand",
};

// "R-0001 · your correction", or just the kind when no request is linked.
export function sourceLabel(sourceKind: string, requestNumber: number | null | undefined): string {
  const kind = MemorySourceKindSchema.safeParse(sourceKind);
  const what = kind.success ? SOURCE_KIND_LABELS[kind.data] : sourceKind.toLowerCase();
  return requestNumber != null ? `${requestRef(requestNumber)} · ${what}` : what;
}

// "Customer · <name>" / "Doc type · Wash care". A customer id that no longer
// resolves shows as plain "Customer" rather than a raw id.
export function scopeLabel(
  scope: string,
  scopeRef: string | null | undefined,
  customerNames: ReadonlyMap<string, string> = new Map(),
): string {
  const parsed = MemoryScopeSchema.safeParse(scope);
  if (!parsed.success) return scope;
  const base = SCOPE_LABELS[parsed.data];
  if (parsed.data === "CUSTOMER") {
    const name = scopeRef ? customerNames.get(scopeRef) : undefined;
    return name ? `${base} · ${name}` : base;
  }
  if (parsed.data === "DOC_TYPE") return scopeRef ? `${base} · ${docTypeLabel(scopeRef)}` : base;
  return base;
}

// ---------- grouping + prompt text (pure) ----------

// Notes per scope in MEMORY_SCOPES order; empty scopes and unknown scope
// strings are left out. Input order is kept inside each group.
export function groupMemoriesByScope<T extends { scope: string }>(
  notes: readonly T[],
): { scope: MemoryScope; notes: T[] }[] {
  return MEMORY_SCOPES.map((scope) => ({ scope, notes: notes.filter((n) => n.scope === scope) })).filter(
    (g) => g.notes.length > 0,
  );
}

// The block appended to the agent's system prompt: one heading per scope,
// one bullet per note. Multi-line notes keep their lines, indented under the
// bullet. Empty input → "" so the caller appends nothing.
export function formatMemoriesForPrompt(notes: readonly { scope: string; text: string }[]): string {
  const groups = groupMemoriesByScope(notes.filter((n) => n.text.trim() !== ""));
  return groups
    .map((g) => {
      const bullets = g.notes.map((n) => `- ${n.text.trim().split(/\r?\n/).join("\n  ")}`);
      return `## ${PROMPT_HEADINGS[g.scope]}\n${bullets.join("\n")}`;
    })
    .join("\n\n");
}

// ---------- state transitions (pure) ----------

const TRANSITIONS: Record<MemoryState, readonly MemoryState[]> = {
  PROPOSED: ["KEPT", "DISMISSED"],
  KEPT: ["FORGOTTEN"],
  DISMISSED: ["PROPOSED", "KEPT"],
  FORGOTTEN: ["KEPT"],
};

// Staying in the same state is an allowed no-op (a double click, a retry).
export function canTransition(from: string, to: MemoryState): boolean {
  if (from === to) return true;
  const parsed = MemoryStateSchema.safeParse(from);
  return parsed.success && TRANSITIONS[parsed.data].includes(to);
}

// Where "Restore" takes a closed note: undoing a dismissal makes it a
// suggestion again; undoing a forget puts it back in use.
export function restoreTarget(state: string): MemoryState | null {
  if (state === "DISMISSED") return "PROPOSED";
  if (state === "FORGOTTEN") return "KEPT";
  return null;
}

// Wording can change while a note is live or still a suggestion; a closed
// note is restored first.
export const TEXT_EDITABLE_STATES: readonly MemoryState[] = ["PROPOSED", "KEPT"];

export function normaliseMemoryText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export type MemoryPatch = { state?: MemoryState; text?: string };
export type MemoryUpdateErrorCode = "not_found" | "empty" | "invalid_text" | "invalid_transition" | "not_editable" | "conflict";

export type MemoryUpdatePlan =
  | { ok: true; changed: boolean; data: { state?: MemoryState; text?: string } }
  | { ok: false; code: MemoryUpdateErrorCode; message: string };

// Decide what a PATCH does to a note, without touching the DB.
export function planMemoryUpdate(current: { state: string; text: string }, patch: MemoryPatch): MemoryUpdatePlan {
  if (patch.state === undefined && patch.text === undefined) {
    return { ok: false, code: "empty", message: "Nothing to change: send a state or a text." };
  }
  const data: { state?: MemoryState; text?: string } = {};

  if (patch.text !== undefined) {
    const text = normaliseMemoryText(patch.text);
    if (!text) return { ok: false, code: "invalid_text", message: "A note can't be empty." };
    if (text.length > MEMORY_TEXT_MAX) {
      return { ok: false, code: "invalid_text", message: `Keep a note under ${MEMORY_TEXT_MAX} characters.` };
    }
    if (!TEXT_EDITABLE_STATES.includes(current.state as MemoryState)) {
      return { ok: false, code: "not_editable", message: "Restore this note before editing it." };
    }
    if (text !== current.text) data.text = text;
  }

  if (patch.state !== undefined) {
    if (!canTransition(current.state, patch.state)) {
      return {
        ok: false,
        code: "invalid_transition",
        message: `A ${labelOfState(current.state).toLowerCase()} note can't become ${STATE_LABELS[patch.state].toLowerCase()}.`,
      };
    }
    if (patch.state !== current.state) data.state = patch.state;
  }

  return { ok: true, changed: Object.keys(data).length > 0, data };
}

function labelOfState(state: string): string {
  const parsed = MemoryStateSchema.safeParse(state);
  return parsed.success ? STATE_LABELS[parsed.data] : state;
}

export class MemoryUpdateError extends Error {
  constructor(
    public code: MemoryUpdateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryUpdateError";
  }
}

// ---------- a note written by hand (pure) ----------

// A person writing a note is the knowledge base: what the agent can't find in
// the data ("an OEKO-TEX page prints because Monday's Certificates column
// says so"). It starts KEPT — a person wrote it, so there is nobody left to
// approve it. The scope's reference is a customer id or a doc-type value;
// GLOBAL and MONDAY take none.
export type NewMemoryInput = { scope: string; scopeRef?: string | null; text: string };

export type NewMemoryPlan =
  | { ok: true; data: { scope: MemoryScope; scopeRef: string | null; text: string } }
  | { ok: false; code: "invalid_scope" | "invalid_text"; message: string };

export function planNewMemory(input: NewMemoryInput): NewMemoryPlan {
  const scope = MemoryScopeSchema.safeParse(input.scope);
  if (!scope.success) return { ok: false, code: "invalid_scope", message: `Unknown scope: ${input.scope}` };
  const text = normaliseMemoryText(input.text);
  if (!text) return { ok: false, code: "invalid_text", message: "A note can't be empty." };
  if (text.length > MEMORY_TEXT_MAX) {
    return { ok: false, code: "invalid_text", message: `Keep a note under ${MEMORY_TEXT_MAX} characters.` };
  }
  const ref = input.scopeRef?.trim() || null;
  if (scope.data === "CUSTOMER" && !ref) return { ok: false, code: "invalid_scope", message: "Pick the customer." };
  if (scope.data === "DOC_TYPE" && !ref) return { ok: false, code: "invalid_scope", message: "Pick the doc type." };
  const needsRef = scope.data === "CUSTOMER" || scope.data === "DOC_TYPE";
  return { ok: true, data: { scope: scope.data, scopeRef: needsRef ? ref : null, text } };
}

// ---------- the follow-along log (pure) ----------

export type MemoryEventKind = "suggested" | "kept" | "dismissed" | "forgotten" | "used";

const EVENT_LABELS: Record<MemoryEventKind, string> = {
  suggested: "Suggested",
  kept: "Kept",
  dismissed: "Dismissed",
  forgotten: "Forgotten",
  used: "Read by the agent",
};

export type MemoryEvent = {
  id: string;
  kind: MemoryEventKind;
  label: string;
  state: string;
  text: string;
  scopeLabel: string;
  source: string;
  when: Date;
};

export function memoryEvent(row: {
  id: string;
  state: string;
  text: string;
  scopeLabel: string;
  sourceLabel: string;
  updatedAt: Date;
  lastUsedAt: Date | null;
}): MemoryEvent {
  const used = row.state === "KEPT" && row.lastUsedAt != null && row.lastUsedAt.getTime() === row.updatedAt.getTime();
  const kind: MemoryEventKind = used
    ? "used"
    : row.state === "KEPT"
      ? "kept"
      : row.state === "DISMISSED"
        ? "dismissed"
        : row.state === "FORGOTTEN"
          ? "forgotten"
          : "suggested";
  return {
    id: row.id,
    kind,
    label: EVENT_LABELS[kind],
    state: row.state,
    text: row.text,
    scopeLabel: row.scopeLabel,
    source: row.sourceLabel,
    when: row.updatedAt,
  };
}

// ---------- reads ----------

export type MemoryListItem = AgentMemory & {
  scopeLabel: string;
  requestNumber: number | null;
  sourceLabel: string;
};

// Request numbers (for "R-0001 · …") and customer names (for the scope tag),
// each in one query.
async function enrich(rows: AgentMemory[]): Promise<MemoryListItem[]> {
  if (rows.length === 0) return [];
  const requestIds = [...new Set(rows.map((r) => r.sourceRequestId).filter((v): v is string => !!v))];
  const customerIds = [
    ...new Set(rows.filter((r) => r.scope === "CUSTOMER" && r.scopeRef).map((r) => r.scopeRef as string)),
  ];
  const [requests, customers] = await Promise.all([
    requestIds.length
      ? orEmpty(db.changeRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, number: true } }), [])
      : [],
    customerIds.length
      ? orEmpty(db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }), [])
      : [],
  ]);
  const numbers = new Map(requests.map((r) => [r.id, r.number]));
  const names = new Map(customers.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const requestNumber = r.sourceRequestId ? (numbers.get(r.sourceRequestId) ?? null) : null;
    return {
      ...r,
      scopeLabel: scopeLabel(r.scope, r.scopeRef, names),
      requestNumber,
      sourceLabel: sourceLabel(r.sourceKind, requestNumber),
    };
  });
}

export async function listMemories(
  filter: { scope?: MemoryScope; state?: MemoryState } = {},
): Promise<MemoryListItem[]> {
  const where: Prisma.AgentMemoryWhereInput = {};
  if (filter.scope) where.scope = filter.scope;
  if (filter.state) where.state = filter.state;
  const rows = await orEmpty(
    db.agentMemory.findMany({ where, orderBy: { updatedAt: "desc" }, take: LIST_LIMIT }),
    [],
  );
  return enrich(rows);
}

export async function memoryLog(limit = 30): Promise<MemoryEvent[]> {
  const take = Math.min(Math.max(1, Math.floor(limit) || 1), LOG_LIMIT_MAX);
  const rows = await orEmpty(db.agentMemory.findMany({ orderBy: { updatedAt: "desc" }, take }), []);
  return (await enrich(rows)).map(memoryEvent);
}

// The KEPT notes for one agent run — global, this customer, this doc type and
// Monday — as a prompt block plus the ids used. Reading them counts as a use:
// usedCount + lastUsedAt are bumped (best effort; a missing table is no run
// blocker).
export async function memoriesForPrompt(
  ctx: { customerId?: string | null; docType?: string | null } = {},
): Promise<{ text: string; ids: string[] }> {
  const scopes: Prisma.AgentMemoryWhereInput[] = [{ scope: "GLOBAL" }, { scope: "MONDAY" }];
  if (ctx.customerId) scopes.push({ scope: "CUSTOMER", scopeRef: ctx.customerId });
  if (ctx.docType) scopes.push({ scope: "DOC_TYPE", scopeRef: ctx.docType });

  const rows = await orEmpty(
    db.agentMemory.findMany({
      where: { state: "KEPT", OR: scopes },
      orderBy: { updatedAt: "desc" },
      take: PROMPT_NOTE_LIMIT,
      select: { id: true, scope: true, text: true, createdAt: true },
    }),
    [],
  );
  // Oldest first inside each scope reads like a history of corrections.
  const notes = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const text = formatMemoriesForPrompt(notes);
  const ids = groupMemoriesByScope(notes).flatMap((g) => g.notes.map((n) => n.id));

  if (ids.length > 0) {
    // One instant for both stamps: memoryLog reads equal values as "used".
    const now = new Date();
    await orEmpty(
      db.agentMemory.updateMany({
        where: { id: { in: ids } },
        data: { usedCount: { increment: 1 }, lastUsedAt: now, updatedAt: now },
      }),
      { count: 0 },
    );
  }
  return { text, ids };
}

// ---------- writes ----------

export class NewMemoryError extends Error {
  constructor(
    public code: "invalid_scope" | "invalid_text",
    message: string,
  ) {
    super(message);
    this.name = "NewMemoryError";
  }
}

// A note written by hand on /settings/agent-memory: KEPT from the start, so
// the next matching run reads it. A customer scope must name a customer that
// exists. Throws NewMemoryError with a message the form shows.
export async function createManualMemory(input: NewMemoryInput & { userId: string }): Promise<AgentMemory> {
  const plan = planNewMemory(input);
  if (!plan.ok) throw new NewMemoryError(plan.code, plan.message);
  if (plan.data.scope === "CUSTOMER") {
    const customer = await db.customer.findUnique({ where: { id: plan.data.scopeRef! }, select: { id: true } });
    if (!customer) throw new NewMemoryError("invalid_scope", "That customer no longer exists.");
  }
  return db.agentMemory.create({
    data: {
      ...plan.data,
      state: "KEPT" satisfies MemoryState,
      sourceKind: "MANUAL" satisfies MemorySourceKind,
      createdById: input.userId,
    },
  });
}

// Apply a PATCH (state and/or text). Throws MemoryUpdateError with a code the
// route maps to 404 / 400 / 409.
export async function updateMemory(id: string, patch: MemoryPatch): Promise<AgentMemory> {
  const current = await db.agentMemory.findUnique({ where: { id } });
  if (!current) throw new MemoryUpdateError("not_found", "No such note.");
  const plan = planMemoryUpdate(current, patch);
  if (!plan.ok) throw new MemoryUpdateError(plan.code, plan.message);
  if (!plan.changed) return current;

  // Compare-and-set on the state we planned from.
  const res = await db.agentMemory.updateMany({ where: { id, state: current.state }, data: plan.data });
  if (res.count === 0) {
    throw new MemoryUpdateError("conflict", "This note changed in the meantime. Reload and try again.");
  }
  const updated = await db.agentMemory.findUnique({ where: { id } });
  if (!updated) throw new MemoryUpdateError("not_found", "No such note.");
  return updated;
}

export function setMemoryState(id: string, state: MemoryState): Promise<AgentMemory> {
  return updateMemory(id, { state });
}

export function editMemoryText(id: string, text: string): Promise<AgentMemory> {
  return updateMemory(id, { text });
}
