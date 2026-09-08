import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import {
  startOrResumeSweep,
  cancelSweep,
  loadSweepStatus,
  loadSweepKindCounts,
  loadSweepFindings,
  loadSweepProblems,
  groupHistograms,
  SweepBusyError,
  type SweepFinding,
} from "@/lib/checks/sweep";

export const runtime = "nodejs";
// This handler never waits for the sweep. POST kicks the run off and returns;
// the run itself is a detached loop that writes its progress to the database,
// which is the only way an hour of work can outlive a request — and the only
// way a deploy in the middle of it costs minutes instead of everything.
export const maxDuration = 60;

// =====================================================
// The all-PO sweep's endpoint.
//
//   GET  [?kind=]  → the current run's progress, the findings grouped by fault,
//                    and (with ?kind) the files in one of those groups.
//   POST {action}  → "start" (or resume an abandoned run), "cancel".
//
// Role gate: canReview, matching /checks. A reviewer already approves outputs
// and repairs delivery; asking "which folders are wrong" is the same job.
//
// NOTHING HERE APPLIES ANYTHING. There is deliberately no bulk-apply endpoint
// and no path from a sweep row into apply-actions.ts. A sweep's findings are
// stale by definition, which is exactly why the per-PO apply re-reads the live
// folder and refuses whatever has changed — bypassing that to make a bulk
// repair quick would remove the only thing standing between a stale scan and a
// deleted file. The rows below link to each PO's own page, and the repair
// happens there, confirmed by name, one folder at a time.
// =====================================================

export async function GET(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const status = await loadSweepStatus();
  if (!status) {
    return NextResponse.json({ sweep: null }, { headers: { "Cache-Control": "no-store" } });
  }

  // The progress read carries counts, never rows: the page polls this every few
  // seconds while a sweep runs, and the whole book's flagged files can run to
  // thousands. A group's actual files are fetched only once it is opened.
  const kind = req.nextUrl.searchParams.get("kind");
  const [counts, problems, pos] = await Promise.all([
    loadSweepKindCounts(status.id),
    loadSweepProblems(status.id),
    kind ? loadSweepFindings(status.id) : Promise.resolve([]),
  ]);
  const groups = groupHistograms(counts);

  const files = kind
    ? pos.flatMap((po) =>
        po.findings
          .filter((f: SweepFinding) => f.kind === kind)
          .map((f: SweepFinding) => ({
            supplierId: po.supplierId,
            poNumber: po.poNumber,
            supplierName: po.supplierName,
            fileName: f.fileName,
            webUrl: f.webUrl,
            verdict: f.verdict,
            detail: f.detail,
            owner: f.owner,
            proposed: f.proposed,
            allowed: f.allowed,
            renameTo: f.renameTo,
            location: f.location,
          })),
      )
    : [];

  return NextResponse.json(
    { sweep: status, groups, files, problems, kind: kind ?? null },
    // A live progress read. Caching it would show a finished sweep as still
    // running, or a finding that has already been repaired.
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;

  if (action === "cancel") {
    const sweepId = typeof body.sweepId === "string" ? body.sweepId : null;
    if (!sweepId) return NextResponse.json({ error: "sweepId is required" }, { status: 400 });
    await cancelSweep(sweepId);
    return NextResponse.json({ ok: true, sweep: await loadSweepStatus(sweepId) }, { headers: { "Cache-Control": "no-store" } });
  }

  if (action !== "start") {
    return NextResponse.json({ error: "action must be “start” or “cancel”" }, { status: 400 });
  }

  try {
    // "Start" also RESUMES: a run whose process died is picked up from the
    // folders it never reached rather than begun again from the top.
    const { sweepId, resumed } = await startOrResumeSweep({
      userId: session.user.id,
      userEmail: session.user.email,
    });
    return NextResponse.json(
      { ok: true, resumed, sweep: await loadSweepStatus(sweepId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof SweepBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[checks-sweep] could not start:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The sweep could not be started" },
      { status: 500 },
    );
  }
}
