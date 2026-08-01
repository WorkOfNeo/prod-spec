import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import { ignoreBaseKey } from "@/lib/outputs/output-field-values";
import {
  isLineKey,
  MAX_LINE_LENGTH,
  saveStyleOutputLineValues,
} from "@/lib/outputs/output-line-values";

export const runtime = "nodejs";
// A re-render can render several PDFs on a cold Puppeteer — allow time.
export const maxDuration = 300;

// Inline LINE rewrites for ONE output of ONE style, then re-render it.
//
// The catch-all beside /output-fields. A field edit fixes DATA and so fixes
// every output printing it; a line edit rewrites one line of one document —
// including text hardcoded in the layout, which no field edit can reach. The
// stored value is a SOURCE line: tokens inside it still resolve, so a reviewer
// can type plain text or repoint the line at a different token.
//
// Gated to canReview (ADMIN or REVIEWER) — same deliberate loosening as
// /output-fields and /carton-customize, scoped to one output.
//
//   POST /api/admin/styles/<id>/output-lines
//     { variantKey: "layout:abc", values: { "<pageId>|<blockId>|0": "Inner box: 5 pair" } }
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
  // STORAGE key = the variantKey as sent: the BASE ("layout:abc") applies the
  // rewrite to EVERY PDF of the output (the default — a hardcoded literal is
  // identical on all of them), the FULL "layout:abc#<suffix>" to one document.
  const storageKey = variantKey.trim();
  // BASE key drives the re-generation scope: a rerun always regenerates the
  // whole output (which re-splits into all its PDFs), never a single document.
  const baseKey = ignoreBaseKey(variantKey, "");

  // Reject malformed keys explicitly — saveStyleOutputLineValues drops them
  // too, but a 400 tells a mis-wired client instead of silently ignoring.
  const badKeys = Object.keys(values).filter((k) => !isLineKey(k));
  if (badKeys.length > 0) {
    return NextResponse.json(
      { error: `Not a line address: ${badKeys.slice(0, 3).join(", ")}` },
      { status: 400 },
    );
  }
  const tooLong = Object.entries(values).filter(
    ([, v]) => typeof v === "string" && v.length > MAX_LINE_LENGTH,
  );
  if (tooLong.length > 0) {
    return NextResponse.json(
      { error: `A line can be at most ${MAX_LINE_LENGTH} characters` },
      { status: 400 },
    );
  }

  const style = await db.style.findUnique({ where: { id }, select: { id: true } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  // One generation at a time per style (mirrors the Run guard / output-fields)
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
    saved = await saveStyleOutputLineValues(id, storageKey, values, {
      outputName,
      updatedById: session.user.id,
    });
  } catch {
    // The additive table isn't deployed yet (db:deploy pending).
    return NextResponse.json(
      { error: "Line edits aren't available yet — run db:deploy to enable them." },
      { status: 503 },
    );
  }

  // Scoped re-generation of just this output — same path as the per-output Run
  // button and /output-fields. The runner picks up the saved lines.
  const { jobId } = await enqueueGenerationJob({
    styleId: id,
    triggerSource: "MANUAL_RERUN",
    variantKeys: [baseKey],
  });
  await db.style.update({ where: { id }, data: { status: "GENERATING" } });
  const count = Object.keys(saved).length;
  await db.log.create({
    data: {
      jobId,
      level: "INFO",
      message: `inline line edits (${count > 0 ? `${count} line${count === 1 ? "" : "s"}` : "cleared"}) for ${storageKey} by ${session.user.email} — re-rendering, re-entering review`,
    },
  });

  // Run inline — the reviewer clicked Save and is waiting on the response.
  const summary = await runPendingJobs(1);

  return NextResponse.json({
    ok: true,
    jobId,
    values: saved,
    jobsProcessed: summary.processed,
    jobsFailed: summary.failed,
  });
}
