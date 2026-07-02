import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";
import { resolveRejectionTicketsFor } from "@/lib/tickets/rejection-tickets";
import { maybeSettleJob } from "@/lib/publish/settle-job";
import { ignoreBaseKey } from "@/lib/outputs/output-ignores";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

export const runtime = "nodejs";
// Ignoring the LAST open asset rolls the job up and publishes the remaining
// approved outputs — SharePoint upload can take a while.
export const maxDuration = 120;

// Per-asset ignore — the third decision next to approve/reject: "this output
// is not wanted for THIS style". Records a StyleOutputIgnore for the asset's
// (style, base variantKey), which from then on:
//   • generation skips the output (runner + every auto-enqueue path),
//   • publish paths drop it (SharePoint upload, per-output delivery),
//   • the nightly supplier email never lists it (queue rows pruned below,
//     enqueue + send both re-check).
// Scoped strictly to this style × this output — other styles on the same
// ProdSpec are untouched. Undo via DELETE /api/admin/styles/[id]/output-ignores.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const asset = await db.jobAsset.findUnique({
    where: { id },
    // reviewEndedAt (additive column) isn't read here and may not be deployed
    // yet — omit it so the ignore path keeps working pre-db:deploy.
    include: { job: { omit: { reviewEndedAt: true } } },
  });
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  const styleId = asset.job.styleId;
  const variantKey = ignoreBaseKey(asset.variantKey, asset.docType);

  // Bundle framing (cover / general info) is derived from the real outputs and
  // regenerated with every run — it isn't a declared output, so an ignore on it
  // would never round-trip through readiness and the card would sit pending
  // forever. The UI hides the button for these; refuse direct calls too.
  if (variantKey === COVER_VARIANT_KEY || variantKey === GENERAL_INFO_VARIANT_KEY) {
    return NextResponse.json(
      { error: "Framing pages (cover / general info) can't be ignored — they regenerate with every run." },
      { status: 400 },
    );
  }

  try {
    await db.styleOutputIgnore.upsert({
      where: { styleId_variantKey: { styleId, variantKey } },
      create: {
        styleId,
        variantKey,
        outputName: asset.displayName ?? asset.docType,
        createdById: session.user.id,
      },
      update: {}, // already ignored — idempotent
    });
  } catch {
    // The one read/write here that must NOT fail-soft: without the row the
    // ignore wouldn't stick. Almost certainly the additive table isn't
    // deployed yet.
    return NextResponse.json(
      { error: "Ignore isn't available yet — the style_output_ignores migration hasn't been deployed (db:deploy)." },
      { status: 503 },
    );
  }

  // Prune any not-yet-sent nightly-queue rows for this output (our own queue
  // bookkeeping; enqueue + the midnight batch also re-check the ignore).
  try {
    await db.supplierSendQueueItem.deleteMany({
      where: { styleId, variantKey, sentAt: null },
    });
  } catch (err) {
    console.warn(`[output-ignore] queue prune failed for ${styleId}/${variantKey}:`, err);
  }

  // Ignoring closes the output's rejection-ticket thread (if any) — an OPEN
  // ticket for an output that will never regenerate would sit in the workbench
  // forever and poison bulk re-runs.
  const resolved = await resolveRejectionTicketsFor(styleId, [asset.variantKey]);

  // Deciding IS taking responsibility — implicit claim when nobody pressed
  // the "Start review" popup first (first writer wins, no-op otherwise).
  await claimReviewIfUnclaimed(asset.jobId, session.user.id);
  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message:
        `output ${variantKey} ignored for this style by ${session.user.email}` +
        ` — skipped from generation, SharePoint upload and the nightly supplier email` +
        (resolved > 0 ? ` · resolved ${resolved} rejection ticket(s)` : ""),
    },
  });

  // The ignored asset no longer holds the review open — settle the job if
  // everything else is decided (publishes the approved remainder).
  return NextResponse.json(await maybeSettleJob(asset.jobId, session.user.id));
}
