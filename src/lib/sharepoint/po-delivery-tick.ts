import { db } from "@/lib/db";
import { sweepPoDelivery, type PoDeliverySweepResult } from "./po-delivery-run";

// =====================================================
// Ride the cron that already exists.
//
// Railway crons live in the dashboard, not in railway.json, and only two cron
// services exist in production:
//
//   cron                → */5 * * * *  →  /api/po-eans/run?sweep=1
//                                     →  /api/jobs/run?sweep=1   (chained --next)
//   supplier-cron-sync  → 0 */6 * * *  →  /api/cron/sync-suppliers
//
// So a new endpoint is inert until somebody adds a service by hand, and the
// alternative — appending a third --next call to the `cron` service's start
// command — edits the one string that drives the EAN and generation sweeps. A
// typo there stops the core automation, which is a bad trade for a read-only
// audit. Instead the delivery sweep rides the 5-minute tick that already runs,
// throttling itself in code.
//
// FOUR PROPERTIES, each protecting the host tick:
//
//   1. SWEEP TICKS ONLY. /api/jobs/run is also hit inline by the webhook
//      receiver after every enqueue — high frequency, latency-sensitive, and
//      not a cron. Only ?sweep=1 (Railway cron, or an operator's "Run now")
//      carries this.
//   2. SELF-THROTTLED. The host fires every 5 minutes, which is far too often
//      for a fleet-wide Graph sweep. The last CronRun of this kind is the
//      clock, so the interval is honoured across restarts and deploys — an
//      in-process timer would reset on every deploy and quietly run hot.
//   3. TIME-BOXED. The host's budget is 300s and the generation drain has
//      first claim on it. The slice takes what is left, capped, and stops
//      starting folders at its deadline.
//   4. BEST-EFFORT. Every failure is swallowed and logged. A Graph outage must
//      never fail a tick whose real job is rendering PDFs.
//
// Nothing here repairs. The sweep is read-only by design (see the cron route):
// this only keeps /delivery current so a human knows where to press the button.
// =====================================================

// How often the slice may actually run, regardless of how often the host ticks.
// 15 minutes against a 5-minute host means it fires on roughly every third tick.
const DEFAULT_INTERVAL_MIN = 15;

// Folders per slice. Each costs ~5 sequential Graph calls plus a current-outputs
// walk per style on it. 10 per 15 minutes ≈ 40/hour, so a ~200-folder fleet
// comes round about every five hours — steady, and nowhere near a burst.
const DEFAULT_LIMIT = 10;

// Hard ceiling on one slice, and the floor of host budget it refuses to start
// under. The generation drain has first claim on the 300s: if it has already
// spent most of that, this tick simply doesn't run — there is another in five
// minutes, and a half-finished sweep is worth less than a finished render.
const MAX_SLICE_MS = 60_000;
const MIN_SLICE_MS = 10_000;
const HOST_BUDGET_MS = 300_000;

const CRON_KIND = "po-delivery";

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export type DeliveryTickOutcome =
  | { ran: false; reason: "not-due" | "no-budget" | "failed" }
  | ({ ran: true } & PoDeliverySweepResult);

// Has the interval elapsed since the last slice? Reading the answer from
// CronRun rather than memory is what makes the throttle survive a deploy.
// A failed read returns "due": missing the clock should mean the sweep still
// happens, just possibly a little early.
async function isDue(intervalMs: number): Promise<boolean> {
  try {
    const last = await db.cronRun.findFirst({
      where: { kind: CRON_KIND },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!last) return true;
    return Date.now() - last.createdAt.getTime() >= intervalMs;
  } catch (err) {
    console.warn("[po-delivery-tick] could not read the last run; treating as due:", err);
    return true;
  }
}

// Run one slice of the fleet sweep if it is due and there is time left.
//
// `hostStartedAt` is the host request's start (epoch ms) — the slice sizes
// itself from what remains of the host's budget, so a tick that spent 4 minutes
// rendering PDFs contributes nothing here instead of pushing the request over.
//
// NEVER throws.
export async function maybeSweepPoDeliveryTick(hostStartedAt: number): Promise<DeliveryTickOutcome> {
  try {
    const intervalMs = envInt("PO_DELIVERY_TICK_INTERVAL_MIN", DEFAULT_INTERVAL_MIN) * 60_000;
    if (!(await isDue(intervalMs))) return { ran: false, reason: "not-due" };

    const remainingHostMs = HOST_BUDGET_MS - (Date.now() - hostStartedAt);
    // Leave a margin so the host can still write its own CronRun row and
    // respond after the slice returns.
    const sliceMs = Math.min(MAX_SLICE_MS, remainingHostMs - 20_000);
    if (sliceMs < MIN_SLICE_MS) return { ran: false, reason: "no-budget" };

    const startedAt = Date.now();
    const result = await sweepPoDelivery({
      limit: envInt("PO_DELIVERY_TICK_LIMIT", DEFAULT_LIMIT),
      deadlineAt: startedAt + sliceMs,
    });

    // Stamped AFTER the slice, so the interval is measured between finishes and
    // a long slice can't immediately re-trigger. This row is also the throttle's
    // clock, so it is written even when the slice checked nothing.
    await db.cronRun
      .create({
        data: {
          kind: CRON_KIND,
          source: "secret",
          processed: result.checked,
          failed: result.skipped,
          durationMs: Date.now() - startedAt,
          note:
            `${result.fullyDelivered} complete · ${result.withShortfall} short · ` +
            `${result.unresolvable} unreadable · ${result.remaining} still queued` +
            (result.ranOutOfTime ? " · cut short on time" : ""),
        },
      })
      .catch((err) => {
        // A missing row only means the next tick thinks it is due — the sweep
        // runs slightly hot rather than not at all. Not worth failing over.
        console.warn("[po-delivery-tick] could not record the run:", err);
      });

    return { ran: true, ...result };
  } catch (err) {
    // The host renders PDFs for a living. An audit must never be why that fails.
    console.warn("[po-delivery-tick] slice failed:", err);
    return { ran: false, reason: "failed" };
  }
}
