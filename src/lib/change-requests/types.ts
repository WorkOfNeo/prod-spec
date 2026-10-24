import { z } from "zod";

// =====================================================
// Change requests — the ONE place the feature's status unions and JSON column
// shapes are defined (design docs/plans/change-requests.md §4). Every status /
// kind column in the change-request tables is TEXT, not a Postgres enum, so a
// later state is a line here instead of an enum migration — which makes this
// file the contract: writers validate against these schemas, readers narrow
// with them, and nothing else re-declares the strings.
//
// PURE LEAF (zod only) — safe for client components, routes, the agent tools
// and the bench alike. Layout edit operations (LayoutOp) are deliberately NOT
// here: src/lib/output-layouts/ops.ts owns that union and its validation, and a
// revision stores its ops as an opaque unknown[] (RevisionOpsSchema).
// =====================================================

// ── Request (the whole report) ───────────────────────────────────────────────
// A summary of its outputs' statuses, rolled up in requests.ts.
export const REQUEST_STATUSES = [
  "NEW",
  "WORKING",
  "IN_REVIEW",
  "NEEDS_INFO",
  "NEEDS_CODE",
  "DONE",
  "REJECTED",
] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

// Who filed it: an admin, or a REVIEWER filing for themselves (they see only
// their own requests; only an admin approves).
export const REQUEST_SOURCES = ["ADMIN", "REQUESTER"] as const;
export const RequestSourceSchema = z.enum(REQUEST_SOURCES);
export type RequestSource = z.infer<typeof RequestSourceSchema>;

// ── Output (one issue per print output — the unit worked and approved) ───────
export const OUTPUT_STATUSES = [
  "NEW",
  "WORKING",
  "IN_REVIEW",
  "NEEDS_INFO",
  "NEEDS_CODE",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
] as const;
export const OutputStatusSchema = z.enum(OUTPUT_STATUSES);
export type OutputStatus = z.infer<typeof OutputStatusSchema>;

// ── Layout revision ──────────────────────────────────────────────────────────
// DRAFT is the only open state: it never prints. PUBLISHED was written to the
// layout by publishRevision(). DISCARDED = rejected / thrown away. SUPERSEDED =
// another revision of the same layout was published while this one was open.
export const REVISION_STATUSES = ["DRAFT", "PUBLISHED", "DISCARDED", "SUPERSEDED"] as const;
export const RevisionStatusSchema = z.enum(REVISION_STATUSES);
export type RevisionStatus = z.infer<typeof RevisionStatusSchema>;

// ── Authors ──────────────────────────────────────────────────────────────────
// Thread messages may come from the system (status notes); a revision is
// always made by a person or the agent.
export const AUTHOR_KINDS = ["USER", "AGENT", "SYSTEM"] as const;
export const AuthorKindSchema = z.enum(AUTHOR_KINDS);
export type AuthorKind = z.infer<typeof AuthorKindSchema>;

export const REVISION_AUTHOR_KINDS = ["USER", "AGENT"] as const;
export const RevisionAuthorKindSchema = z.enum(REVISION_AUTHOR_KINDS);
export type RevisionAuthorKind = z.infer<typeof RevisionAuthorKindSchema>;

// ── Thread messages ──────────────────────────────────────────────────────────
export const MESSAGE_KINDS = ["message", "question", "memory_suggestion", "status"] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

// ── Agent steps ──────────────────────────────────────────────────────────────
// Open-ended on purpose: every tool call logs as `tool:<name>`, and new step
// kinds must not need a type change to be recorded. The known fixed kinds are
// listed for readers that group or label them.
export type StepKind = string;
export const KNOWN_STEP_KINDS = [
  "split",
  "read_images",
  "draft",
  "proof",
  "impact",
  "gap",
  "email",
  "error",
] as const;
export const StepKindSchema = z.string().min(1).max(120);
export function toolStepKind(toolName: string): StepKind {
  return `tool:${toolName}`;
}

// Free-form per-step payload (tool input/output excerpts, timings, …).
export const StepDetailSchema = z.record(z.string(), z.unknown());
export type StepDetail = z.infer<typeof StepDetailSchema>;

// ── Agent memory ─────────────────────────────────────────────────────────────
export const MEMORY_SCOPES = ["GLOBAL", "CUSTOMER", "DOC_TYPE", "MONDAY"] as const;
export const MemoryScopeSchema = z.enum(MEMORY_SCOPES);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// Only KEPT notes ever reach a prompt.
export const MEMORY_STATES = ["PROPOSED", "KEPT", "DISMISSED", "FORGOTTEN"] as const;
export const MemoryStateSchema = z.enum(MEMORY_STATES);
export type MemoryState = z.infer<typeof MemoryStateSchema>;

export const MEMORY_SOURCE_KINDS = ["CORRECTION", "AGENT_FINDING", "REQUEST", "MANUAL"] as const;
export const MemorySourceKindSchema = z.enum(MEMORY_SOURCE_KINDS);
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

// ── Revision ops (OutputLayoutRevision.ops) ──────────────────────────────────
// Stored opaque here; ops.ts parses them into its LayoutOp union.
export const RevisionOpsSchema = z.array(z.unknown());
export type RevisionOps = z.infer<typeof RevisionOpsSchema>;

// ── Code handoff (ChangeRequestOutput.codeSpec) ──────────────────────────────
// What the agent declares with `declare_gap` when the change needs a value no
// existing token can express (design §5.6). The server refuses a declaration
// whose tokenKey already exists. The key must be a legal token name — the same
// shape TOKEN_RE in output-layouts/schema.ts matches — because the developer
// ships exactly that token and resumeAwaitingCode() waits for it by name.
export const GapDeclarationSchema = z.object({
  tokenKey: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "tokenKey must be a token name: a letter, then letters/digits"),
  label: z.string().min(1),
  // Where the value comes from on Monday, with real distributions seen.
  source: z.object({
    board: z.string(),
    column: z.string(),
    examples: z.array(z.object({ value: z.string(), count: z.number().int().min(0) })),
  }),
  // The rule in plain words, plus worked input → output cases.
  rule: z.string().min(1),
  cases: z.array(z.object({ input: z.string(), output: z.string() })),
});
export type GapDeclaration = z.infer<typeof GapDeclarationSchema>;

// The stored spec: the declaration plus the generated build prompt the
// developer copies from /requests/[id]/build-prompt.
export const CodeSpecSchema = GapDeclarationSchema.extend({
  buildPrompt: z.string(),
});
export type CodeSpec = z.infer<typeof CodeSpecSchema>;

// ── Impact (ChangeRequestOutput.impact) ──────────────────────────────────────
// Review status of the style's CURRENT asset for that output. NONE = never
// generated (nothing to rerun or review).
export const IMPACT_REVIEW_STATUSES = ["PENDING_REVIEW", "APPROVED", "REJECTED", "NONE"] as const;
export const ImpactReviewStatusSchema = z.enum(IMPACT_REVIEW_STATUSES);
export type ImpactReviewStatus = z.infer<typeof ImpactReviewStatusSchema>;

// One (style, output) document and whether the proposed definition changes it
// (design §5.4).
export const ImpactRowSchema = z.object({
  styleId: z.string(),
  styleLabel: z.string(),
  poNumber: z.string().nullable(),
  variantKey: z.string(),
  changed: z.boolean(),
  reviewStatus: ImpactReviewStatusSchema,
  // Delivery state of the current asset (SupplierSendQueueItem).
  uploaded: z.boolean(),
  emailed: z.boolean(),
  // A QUEUED/RUNNING job for the style — never rerun underneath it.
  inFlight: z.boolean(),
});
export type ImpactRow = z.infer<typeof ImpactRowSchema>;

export const ImpactCountsSchema = z.object({
  styles: z.number().int().min(0),
  docs: z.number().int().min(0),
  changed: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  // Changed docs per review status — every status present, 0 when none.
  changedByStatus: z.record(ImpactReviewStatusSchema, z.number().int().min(0)),
  // Changed docs that are already approved (rerun needs a second confirmation)
  // and changed docs already uploaded or emailed to the supplier.
  approvedChanged: z.number().int().min(0),
  deliveredChanged: z.number().int().min(0),
});
export type ImpactCounts = z.infer<typeof ImpactCountsSchema>;

export const ImpactSummarySchema = z.object({
  rows: z.array(ImpactRowSchema),
  counts: ImpactCountsSchema,
});
export type ImpactSummary = z.infer<typeof ImpactSummarySchema>;

// ── Display ──────────────────────────────────────────────────────────────────
// ChangeRequest.number → "R-0001". Grows past four digits rather than wrapping.
export function requestRef(number: number): string {
  return `R-${String(number).padStart(4, "0")}`;
}
