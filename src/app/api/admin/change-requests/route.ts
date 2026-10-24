import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import {
  ChangeRequestInputError,
  CreateChangeRequestSchema,
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
// session or 401, then canReview or 403. Filing a request changes nothing that
// prints — an admin approves every change later — so reviewers may file.
// =====================================================

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

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
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateChangeRequestSchema.safeParse(body);
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
