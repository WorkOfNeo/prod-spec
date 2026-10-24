import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { getRequestDetail } from "@/lib/change-requests/store";
import type { OutputStatus } from "@/lib/change-requests/types";
import { startChangeRequestRun } from "@/lib/change-requests/agent/job";

export const runtime = "nodejs";

// =====================================================
// POST /api/admin/change-requests/[id]/run — start the agent (ADMIN).
//
//   { outputId }  → run that one output
//   {}            → run every output that is NEW or FAILED (the "start" and
//                   "try again" buttons)
//
// Answers 202 at once with what was started and what was skipped and why; the
// runs continue in the background and the request page polls for them. The
// agent only reads and drafts (design §2), so starting one is safe to repeat:
// an output already being worked on is skipped, never run twice.
//
// 404 for everyone while CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({ outputId: z.string().trim().min(1).optional() });

// A settled output (approved, published, rejected) has nothing left to draft;
// WORKING is refused by startChangeRequestRun itself.
const RUNNABLE: ReadonlySet<string> = new Set<OutputStatus>(["NEW", "FAILED", "IN_REVIEW", "NEEDS_INFO", "NEEDS_CODE"]);
const BULK: ReadonlySet<string> = new Set<OutputStatus>(["NEW", "FAILED"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  // The body is optional: an empty POST means "run everything runnable".
  const raw = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  const { outputId } = parsed.data;

  const detail = await getRequestDetail(id);
  if (!detail) return NextResponse.json({ error: "Change request not found" }, { status: 404 });

  const targets = outputId
    ? detail.outputs.filter((o) => o.id === outputId)
    : detail.outputs.filter((o) => BULK.has(o.status));
  if (outputId && targets.length === 0) {
    return NextResponse.json({ error: "Output not found on this request" }, { status: 404 });
  }

  const started: string[] = [];
  const skipped: { outputId: string; reason: string }[] = [];
  for (const output of targets) {
    if (!RUNNABLE.has(output.status)) {
      skipped.push({ outputId: output.id, reason: `The output is ${output.status.toLowerCase().replace(/_/g, " ")}` });
      continue;
    }
    const res = await startChangeRequestRun(output.id, { trigger: "new", userId: session.user.id });
    if (res.started) started.push(output.id);
    else skipped.push({ outputId: output.id, reason: res.reason });
  }

  return NextResponse.json({ started, skipped }, { status: 202 });
}
