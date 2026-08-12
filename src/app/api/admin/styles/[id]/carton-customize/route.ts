import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { renderCartonCustomization } from "@/lib/output-layouts/carton-render";
import { notifyReviewReady } from "@/lib/notifications/user-notifications";
import { getReviewNotificationEmails } from "@/lib/settings/app-settings";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";
import { hasPoNumber } from "@/lib/styles/active-filter";

export const runtime = "nodejs";
// A carton numbering set can be many pages — one Chromium render, allow time.
export const maxDuration = 300;

// Carton customization PERSISTED INTO REVIEW. Unlike its sibling
// /carton-prints (which streams a one-off download), this regenerates the
// single carton output with the chosen customization, stores it as a JobAsset
// under a fresh scoped job, and flips the style back to AWAITING_REVIEW — so the
// customized set RE-ENTERS review and REPLACES the prior asset for that output
// (getCurrentOutputsForStyle reads the newest asset per variantKey across all
// jobs; other outputs' approvals live on older jobs and survive).
//
// Reviewers may run this: finalizing a carton for print is part of reviewing,
// so it's gated to canReview (ADMIN or REVIEWER) — deliberately looser than the
// ADMIN-only generation rule for this one scoped action. The two capabilities
// are INDEPENDENT and may combine in a single request (renderCartonCustomization
// binds both) — a numbered set that ALSO carries other styles on the box:
//   • carton numbering — body { total } with total > 1 (each page 1/N … N/N).
//   • multiple styles  — body { siblingIds: [...] } (fills {{style2}}… slots).
//
//   POST /api/admin/styles/<id>/carton-customize → { ok, jobId }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let variantKey = "";
  let total = 1;
  let siblingIds: string[] | null = null;
  try {
    const body = (await req.json()) as {
      variantKey?: unknown;
      total?: unknown;
      siblingIds?: unknown;
    };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey;
    if (typeof body?.total === "number") total = body.total;
    if (Array.isArray(body?.siblingIds)) {
      siblingIds = body.siblingIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const baseKey = variantKey.split("#")[0];

  // One generation at a time per style (mirrors the per-output Run guard) so a
  // customization can't race the runner or another customize.
  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return NextResponse.json(
      { error: "A job is already in flight for this style" },
      { status: 409 },
    );
  }

  const style = await db.style.findUnique({
    where: { id },
    select: { prodSpecId: true, poNumber: true },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // The PO gate. This route creates its job directly (RUNNING, not QUEUED — see
  // below) and so never reaches enqueueGenerationJob's throw; without this check
  // a customization would be the one way to render a style that has not entered
  // the flow. 422, not 409: nothing is racing, the style just isn't eligible.
  if (!hasPoNumber(style.poNumber)) {
    return NextResponse.json(
      { error: "This style has no PO number yet, so nothing can be generated for it" },
      { status: 422 },
    );
  }

  // Create the job already RUNNING (never QUEUED) so the background runner
  // can't claim it and render a plain, non-customized output — we render it
  // ourselves below. triggerSource MANUAL_RERUN: publishApprovedJob already
  // flags it as a supplier "correction", and no enum migration is needed.
  const job = await db.job.create({
    data: {
      styleId: id,
      prodSpecId: style.prodSpecId ?? null,
      triggerSource: "MANUAL_RERUN",
      status: "RUNNING",
      startedAt: new Date(),
      variantKeys: [baseKey],
    },
  });

  try {
    const result = await renderCartonCustomization(id, { variantKey, total, siblingIds });
    if (!result.ok) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "FAILED", error: result.error, finishedAt: new Date() },
      });
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const siblingCount = siblingIds?.length ?? 0;
    // The capabilities compose — describe whichever are in play (both, one, or
    // neither) so the review card labels the asset accurately.
    const noteParts: string[] = [];
    if (result.numbered) noteParts.push(`carton numbering 1–${total}`);
    if (result.multi) {
      noteParts.push(
        `multiple styles (${siblingCount} other${siblingCount === 1 ? "" : "s"} on the box)`,
      );
    }
    const modeNote = noteParts.length ? noteParts.join(" + ") : "single carton";

    await db.$transaction([
      // ONE multi-page asset at the BASE key — supersedes the prior carton
      // asset for this output slot in current-outputs (newest per variantKey).
      db.jobAsset.create({
        data: {
          jobId: job.id,
          docType: result.docType,
          variantKey: baseKey,
          displayName: `${result.layoutName} · ${modeNote}`,
          fileName: result.fileName,
          pdf: toBytes(result.pdf),
          placeholderCount: result.placeholderCount,
        },
      }),
      db.job.update({
        where: { id: job.id },
        data: { status: "AWAITING_REVIEW", finishedAt: new Date() },
      }),
      db.style.update({ where: { id }, data: { status: "AWAITING_REVIEW" } }),
      db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message: `carton customize (${modeNote}) for ${baseKey} by ${session.user.email} — replaces current output, re-entering review`,
        },
      }),
    ]);

    // The customizer takes the re-review on (best-effort, first-writer-wins) and
    // the in-app review feed refreshes for admins. No email: the reviewer
    // triggered this and is already on the screen (mirrors the runner, which
    // also keeps in-app-only for operator-driven re-runs).
    await claimReviewIfUnclaimed(job.id, session.user.id);
    const recipients = await getReviewNotificationEmails();
    await notifyReviewReady(recipients, {
      type: "REVIEW_READY",
      title: "Carton output customized — ready for review",
      body: `${result.layoutName} · ${modeNote}`,
      href: `/styles/${id}/review`,
      jobId: job.id,
      styleId: id,
    });

    return NextResponse.json({ ok: true, jobId: job.id });
  } catch (e) {
    await db.job
      .update({
        where: { id: job.id },
        data: { status: "FAILED", error: (e as Error).message, finishedAt: new Date() },
      })
      .catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}

// Buffer → plain Uint8Array for the Prisma Bytes column (mirrors the runner's
// toPlainBytes; a fresh copy detaches from any pooled Buffer backing store).
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}
