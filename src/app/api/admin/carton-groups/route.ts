import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { createCartonGroup } from "@/lib/carton-groups/groups";

export const runtime = "nodejs";
// One Chromium render, possibly a numbered set — allow time (mirrors the
// sibling carton routes).
export const maxDuration = 300;

// Create a MULTI-STYLE CARTON GROUP: several styles from one PO that ship in one
// box and share a single carton marking.
//
// Gated to canReview (ADMIN or REVIEWER), like /carton-customize: deciding how a
// carton is packed is part of reviewing it. Reviewers are the people standing in
// front of this problem, so they may group without an admin.
//
//   POST /api/admin/carton-groups → { ok, groupId, jobId, fileName }
export async function POST(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  let mainStyleId = "";
  let otherStyleIds: string[] = [];
  let variantKey = "";
  let totalCartons: number | null = null;
  try {
    const body = (await req.json()) as {
      mainStyleId?: unknown;
      otherStyleIds?: unknown;
      variantKey?: unknown;
      totalCartons?: unknown;
    };
    if (typeof body?.mainStyleId === "string") mainStyleId = body.mainStyleId;
    if (typeof body?.variantKey === "string") variantKey = body.variantKey;
    if (typeof body?.totalCartons === "number") totalCartons = body.totalCartons;
    if (Array.isArray(body?.otherStyleIds)) {
      otherStyleIds = body.otherStyleIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (!mainStyleId) return NextResponse.json({ error: "mainStyleId required" }, { status: 400 });
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  try {
    const result = await createCartonGroup({
      mainStyleId,
      otherStyleIds,
      variantKey,
      totalCartons,
      userId: session.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create the carton group" },
      { status: 500 },
    );
  }
}
