import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import {
  ChangeRequestInputError,
  ChangeRequestRateLimitError,
  CreateChangeRequestSchema,
  MAX_REQUEST_BODY_BYTES,
  assertCanFileRequest,
  createChangeRequest,
  listChangeRequests,
} from "@/lib/change-requests/requests";
import { RequestStatusSchema } from "@/lib/change-requests/types";
import { startRunsForRequest } from "@/lib/change-requests/agent/job";

export const runtime = "nodejs";

// =====================================================
// Change requests — the collection.
//
//   GET  [?status=]  → the inbox rows. Reviewers get their own requests only;
//                      the scoping lives in listChangeRequests, not here.
//   POST {…}         → file a request (the /requests/new form). An ADMIN files
//                      with source ADMIN, a REVIEWER with source REQUESTER.
//
// Gate: the feature flag first (off → 404, the feature does not exist), then
// session or 401, then ADMIN or 403 (change requests are admin-only). Filing a request changes nothing that
// prints — an admin approves every change later — so reviewers may file.
//
// Limits on POST, both before the body is parsed: a body over
// MAX_REQUEST_BODY_BYTES is a 413 (by Content-Length, and counted while
// reading when none is sent), and a person who filed CREATE_LIMIT_PER_HOUR
// requests in the last hour gets a 429 — admins included.
// =====================================================

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

const TOO_LARGE = "The request is too large — attach fewer or smaller screenshots.";

// The body as JSON, never holding more than `limit` bytes: a declared
// Content-Length over it is refused before reading, and a body without one
// (chunked) is counted as it streams in.
async function readJsonCapped(
  req: NextRequest,
  limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) return { ok: false, status: 413 };
  if (!req.body) return { ok: false, status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const rawStatus = req.nextUrl.searchParams.get("status");
  const status = rawStatus ? RequestStatusSchema.safeParse(rawStatus) : null;
  if (status && !status.success) return NextResponse.json({ error: "Unknown status" }, { status: 400 });

  const rows = await listChangeRequests({
    viewer: { userId: session.user.id, role },
    status: status?.data,
  });
  return NextResponse.json({ requests: rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!changeRequestsEnabled()) return notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    return NextResponse.json({ error: TOO_LARGE }, { status: 413 });
  }
  try {
    await assertCanFileRequest(session.user.id);
  } catch (err) {
    if (err instanceof ChangeRequestRateLimitError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const body = await readJsonCapped(req, MAX_REQUEST_BODY_BYTES);
  if (!body.ok) {
    return body.status === 413
      ? NextResponse.json({ error: TOO_LARGE }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateChangeRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const created = await createChangeRequest(parsed.data, { userId: session.user.id, role });
    // The agent starts on every output straight away; each start only claims
    // the output and returns, so the response never waits on the model.
    await startRunsForRequest(created.id, session.user.id).catch((err) => {
      console.warn(`[change-requests] auto-start failed for ${created.id}:`, err);
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof ChangeRequestInputError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
