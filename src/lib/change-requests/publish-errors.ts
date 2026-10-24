// =====================================================
// Change requests — the typed errors of approve / reject / rerun, and the one
// mapping from any typed error to an HTTP answer.
//
// Kept apart from publish.ts (which pulls in the database, the renderer and
// the queue) so routes and their tests can map errors without loading any of
// that. PURE: no imports.
//
// Every typed error in the feature carries the status a route should answer
// with as `httpStatus` (RevisionConflictError 409, RevisionValidationError
// 422, RevisionNotFoundError 404, ImpactTooLargeError 422, ProofNotFoundError
// 404, …), so the mapping reads that field instead of importing each class —
// and passes through what the review screen needs to act on: a conflict's
// details (to offer "Publish anyway") and a validation failure's list.
// =====================================================

// No such change-request output.
export class OutputNotFoundError extends Error {
  readonly httpStatus = 404;
  constructor(readonly outputId: string) {
    super("Change-request output not found");
    this.name = "OutputNotFoundError";
  }
}

// The output (or its current draft) is not in a state that allows the action:
// approving something that isn't in review, a draft another publish replaced,
// rejecting what is already live, a second approval while one is running.
export class OutputStateError extends Error {
  readonly httpStatus = 409;
  constructor(
    message: string,
    // The output's status when refused (null when the output itself is fine
    // and something else — its draft, a lock — was the reason).
    readonly status: string | null = null,
  ) {
    super(message);
    this.name = "OutputStateError";
  }
}

// A reject reason is required and short: it goes into the requester's email.
export const REJECT_REASON_MAX = 500;

// A bad input the route's schema did not catch (a reason that is only
// whitespace once trimmed).
export class PublishInputError extends Error {
  readonly httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = "PublishInputError";
  }
}

export type ErrorResponse = { status: number; body: Record<string, unknown> };

// The answer for a typed error, or null for anything else (a real bug or an
// outage: let it surface as a 500).
export function publishErrorResponse(err: unknown): ErrorResponse | null {
  if (!(err instanceof Error)) return null;
  const status = (err as { httpStatus?: unknown }).httpStatus;
  if (typeof status !== "number" || status < 400 || status > 499) return null;
  const body: Record<string, unknown> = { error: err.message };
  const extra = err as { conflict?: unknown; details?: unknown };
  if (extra.conflict && typeof extra.conflict === "object") body.conflict = extra.conflict;
  if (Array.isArray(extra.details)) body.details = extra.details;
  return { status, body };
}
