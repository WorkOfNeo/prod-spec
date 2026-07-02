import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { publishApprovedJob, PublishError } from "@/lib/publish/publish-approved-job";

export const runtime = "nodejs";
// Publishing many styles is slow — each one uploads to SharePoint, refreshes
// the share link and enqueues the supplier send. Give the loop plenty of room.
export const maxDuration = 300;

// Retroactive bulk-approve for a whole prod spec. Context: an admin marks a
// spec trusted, but styles generated earlier are still sitting unapproved in
// review. This walks those styles and runs the SAME publish path as the
// per-job "Approve all & publish" button (publishApprovedJob) for each — so
// nothing about approval is reinvented here.
//
// Body: { styleIds?: string[] } — omit / empty to approve ALL eligible styles
// under this prod spec (styles whose latest job is AWAITING_REVIEW). Returns a
// per-style result so blocked (placeholder ship-gate) and nothing-to-approve
// styles surface individually.
type StyleResult = {
  styleId: string;
  name: string;
  status: "approved" | "blocked" | "skipped";
  detail?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let requestedIds: string[] = [];
  try {
    const body = (await req.json()) as { styleIds?: unknown };
    if (Array.isArray(body?.styleIds)) {
      requestedIds = body.styleIds.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // No body / not JSON — treat as "approve all eligible".
  }

  // Scope to this prod spec's live styles. When explicit IDs are given, still
  // constrain to this spec so a caller can't approve styles outside it.
  const styles = await db.style.findMany({
    where: {
      prodSpecId: id,
      deletedAt: null,
      archivedAt: null,
      ...(requestedIds.length > 0 ? { id: { in: requestedIds } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { updatedAt: "desc" },
  });

  const results: StyleResult[] = [];

  for (const style of styles) {
    // The latest job for the style — approval only applies when it's still
    // AWAITING_REVIEW (a newer QUEUED/RUNNING/APPROVED job means there's
    // nothing to retroactively approve).
    const latestJob = await db.job.findFirst({
      where: { styleId: style.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (!latestJob || latestJob.status !== "AWAITING_REVIEW") {
      results.push({ styleId: style.id, name: style.name, status: "skipped", detail: "nothing to approve" });
      continue;
    }

    try {
      await publishApprovedJob(latestJob.id, auth.userId);
      results.push({ styleId: style.id, name: style.name, status: "approved" });
    } catch (err) {
      if (err instanceof PublishError) {
        // 409 = ship-gate: an asset still carries placeholder artifacts.
        const blocked = err.httpStatus === 409;
        results.push({
          styleId: style.id,
          name: style.name,
          status: blocked ? "blocked" : "skipped",
          detail: blocked ? "blocked (placeholders)" : err.message,
        });
        continue;
      }
      // Unexpected error — surface it against the style but keep going so one
      // bad style doesn't sink the whole batch.
      results.push({
        styleId: style.id,
        name: style.name,
        status: "skipped",
        detail: err instanceof Error ? err.message : "approval failed",
      });
    }
  }

  const approved = results.filter((r) => r.status === "approved").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return NextResponse.json({ ok: true, results, approved, blocked, skipped });
}
