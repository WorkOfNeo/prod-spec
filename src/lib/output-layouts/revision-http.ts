import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import {
  RevisionConflictError,
  RevisionNotFoundError,
  RevisionStateError,
  RevisionValidationError,
  type RevisionRow,
  type RevisionSummary,
} from "./revisions";

// =====================================================
// The HTTP edge shared by the layout revision routes
// (/api/admin/output-layouts/[id]/revisions and
// /api/admin/output-layouts/revisions/[revisionId]/…, design §6).
// SERVER-ONLY.
//
// Six handlers answer the same gate and map the same four typed errors from
// revisions.ts, so both live here once: a route that forgot the flag check, or
// answered a conflict without saying what moved, would be a quiet hole in a
// path that can change what prints.
// =====================================================

type Gate = { ok: true; userId: string } | { ok: false; response: NextResponse };

// Order matters: with CHANGE_REQUESTS_ENABLED off every route is a 404 to
// everyone (rail 4 — the feature isn't there), before any session lookup.
// Then 401 without a session, 403 for anyone but an ADMIN: only an admin
// reads layout history, makes drafts or puts anything live.
export async function gateRevisionRoute(): Promise<Gate> {
  if (!changeRequestsEnabled()) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  if (!isAdmin(role)) {
    return { ok: false, response: NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 }) };
  }
  return { ok: true, userId: session.user.id };
}

// The typed errors → their HTTP answer. A conflict carries what moved (so the
// UI can say "edited in the builder" vs "published again" and offer force);
// a validation failure carries the publish gate's details, the same
// { error, details } 422 the builder's own Publish button answers. Anything
// else is not ours to explain and is rethrown (→ 500).
export function revisionErrorResponse(err: unknown): NextResponse {
  if (err instanceof RevisionNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof RevisionConflictError) {
    return NextResponse.json({ error: err.message, conflict: err.conflict }, { status: 409 });
  }
  if (err instanceof RevisionStateError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof RevisionValidationError) {
    return NextResponse.json({ error: err.message, details: err.details }, { status: 422 });
  }
  throw err;
}

// A JSON object body, where an empty body counts as {} (every field on these
// routes is optional except restore's `which`, which its schema checks).
export async function readJsonObject(
  req: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const text = await req.text().catch(() => "");
  if (!text.trim()) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 }) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

// A revision row without its two definition blobs — what the list returns,
// and all a caller needs back from a publish or restore.
export function toRevisionSummary(row: RevisionRow): RevisionSummary {
  const summary: Partial<RevisionRow> = { ...row };
  delete summary.definition;
  delete summary.baseDefinition;
  return summary as RevisionSummary;
}
