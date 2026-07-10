import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import { ignoreBaseKey, saveStyleOutputFieldValues } from "@/lib/outputs/output-field-values";
import { PINNABLE_FIELDS } from "@/lib/pdf/pins-meta";

export const runtime = "nodejs";
// A re-render can render several PDFs on a cold Puppeteer — allow time.
export const maxDuration = 300;

// Inline field values for ONE output of ONE style, then re-render it.
//
// The reviewer fills a missing/blocked field (so the output can generate) or
// overrides a value on an already-generated one. The values are stored per
// (style, base output) and compose with the ProdSpec output's pins (per-style
// wins) — see output-field-values.ts. We then run the SAME scoped generation
// the per-output Run button uses: the runner's readiness gate now sees the
// filled field as satisfied (so a previously-blocked output generates) and the
// render merges the value in (so it prints). The output re-enters review.
//
// Gated to canReview (ADMIN or REVIEWER): filling a field to finalize an output
// is part of reviewing — the same deliberate loosening as /carton-customize,
// scoped to one output.
//
//   POST /api/admin/styles/<id>/output-fields
//     { variantKey: "layout:abc", values: { colourName: "Navy" }, outputName?: "…" }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let variantKey = "";
  let outputName: string | null = null;
  let values: Record<string, unknown> = {};
  try {
    const body = (await req.json()) as {
      variantKey?: unknown;
      outputName?: unknown;
      values?: unknown;
    };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey;
    if (typeof body?.outputName === "string") outputName = body.outputName;
    if (body?.values && typeof body.values === "object" && !Array.isArray(body.values)) {
      values = body.values as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (!variantKey.trim()) {
    return NextResponse.json({ error: "variantKey required" }, { status: 400 });
  }
  // STORAGE key = the variantKey as sent: the BASE ("layout:abc") for a
  // single-document output or the pre-generation missing-field fill (applies to
  // every PDF), or the FULL "layout:abc#<suffix>" for one PDF of a multi-doc
  // (repeat-per-EAN) output — a per-PDF override that layers over the base.
  const storageKey = variantKey.trim();
  // BASE key drives the re-generation scope: a rerun always regenerates the
  // whole output (which re-splits into all its PDFs), never a single document.
  const baseKey = ignoreBaseKey(variantKey, "");

  // Reject any non-pinnable field explicitly (structured/derived fields — sizes,
  // EANs, wash care — stay authoritative). saveStyleOutputFieldValues also drops
  // them, but a 400 tells a mis-wired client instead of silently ignoring.
  const unknownFields = Object.keys(values).filter(
    (k) => !(PINNABLE_FIELDS as string[]).includes(k),
  );
  if (unknownFields.length > 0) {
    return NextResponse.json(
      { error: `Not editable: ${unknownFields.join(", ")}` },
      { status: 400 },
    );
  }

  const style = await db.style.findUnique({ where: { id }, select: { id: true } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // One generation at a time per style (mirrors the Run guard / carton-customize)
  // so a save+re-render can't race the runner.
  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return NextResponse.json({ error: "A job is already in flight for this style" }, { status: 409 });
  }

  // Persist first, so the scoped generation below reads the new values.
  let saved: Record<string, string>;
  try {
    saved = await saveStyleOutputFieldValues(id, storageKey, values, {
      outputName,
      updatedById: session.user.id,
    });
  } catch {
    // The additive table isn't deployed yet (db:deploy pending).
    return NextResponse.json(
      { error: "Editable fields aren't available yet — run db:deploy to enable them." },
      { status: 503 },
    );
  }

  // Scoped re-generation of just this output — same path as the per-output Run
  // button, but reviewer-accessible. The runner picks up the saved values.
  const { jobId } = await enqueueGenerationJob({
    styleId: id,
    triggerSource: "MANUAL_RERUN",
    variantKeys: [baseKey],
  });
  await db.style.update({ where: { id }, data: { status: "GENERATING" } });
  const fieldNote = Object.keys(saved).length > 0 ? Object.keys(saved).join(", ") : "cleared";
  await db.log.create({
    data: {
      jobId,
      level: "INFO",
      message: `inline field values (${fieldNote}) for ${storageKey} by ${session.user.email} — re-rendering, re-entering review`,
    },
  });

  // Run inline — the reviewer clicked Save and is waiting on the response.
  const summary = await runPendingJobs(1);

  const emailRows = await db.emailLog.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, status: true, to: true, cc: true, subject: true, attachments: true },
  });

  return NextResponse.json({
    ok: true,
    jobId,
    values: saved,
    jobsProcessed: summary.processed,
    jobsFailed: summary.failed,
    emails: emailRows.map((e) => ({
      emailLogId: e.id,
      type: e.type,
      status: e.status,
      to: e.to,
      cc: e.cc,
      subject: e.subject,
      attachments: e.attachments,
    })),
  });
}
