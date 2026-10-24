import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { appendMessage, getRequestDetail } from "@/lib/change-requests/store";
import { startChangeRequestRun, type RunTrigger } from "@/lib/change-requests/agent/job";

export const runtime = "nodejs";

// =====================================================
// POST /api/admin/change-requests/[id]/messages — post to the review thread.
//
//   { outputId?, body }   body 1..5000 characters
//
// Who may post: ADMIN only (change requests are admin-only for now). The
// requester branch below stays for when filing opens to reviewers.
//
// A message on one output can restart the agent: an admin comment on a draft
// in review (IN_REVIEW → trigger "comment") or an answer to the agent's
// question (NEEDS_INFO → trigger "answer"). The message is stored first so the
// run sees it in the thread. 201 { message, started }.
//
// 404 for everyone while CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({
  outputId: z.string().trim().min(1).optional(),
  body: z
    .string()
    .trim()
    .min(1, "The message is empty")
    .max(5000, "The message is longer than 5000 characters"),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  const { outputId, body } = parsed.data;

  const detail = await getRequestDetail(id);
  if (!detail) return NextResponse.json({ error: "Change request not found" }, { status: 404 });
  const output = outputId ? detail.outputs.find((o) => o.id === outputId) : undefined;
  if (outputId && !output) return NextResponse.json({ error: "Output not found on this request" }, { status: 404 });

  const admin = isAdmin(role);
  if (!admin) {
    if (detail.createdById !== session.user.id) {
      return NextResponse.json({ error: "You can only reply on requests you filed" }, { status: 403 });
    }
    if (!output || output.status !== "NEEDS_INFO") {
      return NextResponse.json(
        { error: "Reviewers can only answer a question the agent asked on one of their outputs" },
        { status: 403 },
      );
    }
  }

  const message = await appendMessage({
    requestId: detail.id,
    outputId: output?.id ?? null,
    authorKind: "USER",
    authorUserId: session.user.id,
    kind: "message",
    body,
  });

  let trigger: RunTrigger | null = null;
  if (output?.status === "NEEDS_INFO") trigger = "answer";
  else if (output?.status === "IN_REVIEW" && admin) trigger = "comment";

  let started = false;
  if (output && trigger) {
    const res = await startChangeRequestRun(output.id, { trigger, userId: session.user.id });
    started = res.started;
  }

  return NextResponse.json({ message, started }, { status: 201 });
}
