import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runPendingJobs } from "@/lib/queue/runner";
import { sweepReadyStyleGenerations, describeGenSweep, type GenSweepSummary } from "@/lib/queue/generation-sweep";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { triggerRunner } from "@/lib/queue/trigger";
// Type-only: the module itself is dynamically imported below so the Graph stack
// stays out of the hot inline-trigger path.
import type { DeliveryTickOutcome } from "@/lib/sharepoint/po-delivery-tick";

export const runtime = "nodejs";
export const maxDuration = 300;

type Authz =
  | { ok: true; source: "secret" | "session" }
  | { ok: false; status: 401 | 403; error: string };

// Accepts requests from:
//  - The webhook receiver firing inline after enqueue (sends ?secret=)
//  - Railway cron (sends ?secret=)
//  - The admin "Run now" button (signed-in ADMIN session, no secret needed)
// The secret (automation) path is role-agnostic; the interactive session
// path is ADMIN-only — a signed-in REVIEWER must not be able to drain the
// generation queue by hitting this endpoint directly.
async function authorize(req: NextRequest): Promise<Authz> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
  if (secret && provided && timingSafeEqual(secret, provided)) return { ok: true, source: "secret" };

  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };
  if (!isAdmin(role)) return { ok: false, status: 403, error: "Requires role: ADMIN" };
  return { ok: true, source: "session" };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// In-process single-flight guard. Only one drain runs per server process at a
// time, so the self-chain re-trigger below and the Railway cron tick can't
// stack concurrent Puppeteer renders (the memory blow-up the bulk "Run all
// outputs" action would otherwise risk). In-memory on purpose: it self-clears
// on restart (no stuck lock), and a hand-off that lands while busy simply
// no-ops — the cron is the backstop. Assumes the usual single web instance;
// with replicas it still bounds renders to one PER instance, which is what
// matters for memory.
let draining = false;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const authz = await authorize(req);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }

  // A drain is already in flight in this process — don't spin up a second
  // concurrent renderer. The active drain self-chains (below) until the queue
  // is empty, so nothing is dropped; this tick just steps aside.
  if (draining) {
    return NextResponse.json({ ok: true, skipped: true, reason: "runner busy" });
  }

  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? "5"), 1), 20);
  const sweep = req.nextUrl.searchParams.get("sweep") === "1";

  // ?sweep=1 (Railway cron / "Run now") first pulls the backlog of ready-but-
  // ungenerated styles into the queue; the inline webhook trigger omits it and
  // just drains the job it enqueued.
  let sweepEnqueued = 0;
  let sweepStyleIds: string[] = [];
  let sweptSummary: GenSweepSummary | null = null;
  let summary: Awaited<ReturnType<typeof runPendingJobs>> = { processed: 0, failed: 0, jobIds: [] };
  draining = true;
  try {
    if (sweep) {
      sweptSummary = await sweepReadyStyleGenerations(10);
      sweepEnqueued = sweptSummary.enqueued;
      sweepStyleIds = sweptSummary.styleIds;
    }
    summary = await runPendingJobs(limit);
  } finally {
    // Always release the guard, even if a render throws, so the queue can't
    // wedge itself shut.
    draining = false;
  }

  // Piggyback: the PO delivery audit rides this tick rather than needing its own
  // Railway cron service (there are only two, both added by hand in the
  // dashboard). SWEEP ONLY — the inline webhook trigger hits this endpoint after
  // every enqueue and must stay fast. The slice throttles itself to ~15 minutes,
  // sizes itself from the budget this drain left behind, and never throws; see
  // po-delivery-tick.ts. Read-only: it records what is missing, it never pushes.
  //
  // Skipped when the drain came up FULL: that means more jobs are queued and
  // the self-chain below is about to fire, so spending up to a minute auditing
  // folders would stall a bulk "Run all" mid-flight. Generation has priority;
  // the audit waits for a tick where the queue has room.
  const queueSaturated = summary.jobIds.length >= limit;
  let deliveryTick: DeliveryTickOutcome | null = null;
  if (sweep && !queueSaturated) {
    const { maybeSweepPoDeliveryTick } = await import("@/lib/sharepoint/po-delivery-tick");
    deliveryTick = await maybeSweepPoDeliveryTick(startedAt);
  }

  // Record cron ticks (sweep) + operator "Run now" (session); skip the
  // high-frequency inline webhook triggers (secret without sweep).
  if (sweep || authz.source === "session") {
    await db.cronRun.create({
      data: {
        kind: "jobs",
        source: authz.source,
        processed: summary.processed,
        failed: summary.failed,
        enqueued: sweepEnqueued,
        jobIds: summary.jobIds,
        styleIds: sweepStyleIds,
        // "checked N · enqueued M · nothing_pending X · floated Y" — so a tick
        // that queues nothing says WHY on /automation instead of a blank "idle".
        note: sweptSummary ? describeGenSweep(sweptSummary) : undefined,
        durationMs: Date.now() - startedAt,
      },
    });
  }

  // Self-chain: a full batch (we claimed `limit` jobs) almost certainly means
  // more are queued, so kick the next drain immediately instead of waiting for
  // the next ~5-min cron tick — this is what makes a bulk "Run all" drain
  // continuously. Fired AFTER releasing the guard so the next invocation can
  // claim it. The chain ends on its own when a drain comes up short (queue
  // emptied → fewer than `limit` claimed → no re-trigger).
  if (queueSaturated) {
    void triggerRunner();
  }

  return NextResponse.json({ ...summary, sweepEnqueued, deliveryTick });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in session" });
}
