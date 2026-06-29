import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/lib/auth-server";
import {
  getPoEanAutoRunEnabled,
  getAutoGenerateEnabled,
  getAutomationMinPo,
} from "@/lib/settings/app-settings";
import { eanStatusMeta, MAX_EAN_ATTEMPTS } from "@/lib/po/ean-status-meta";
import { RunNowButton } from "./run-now-button";
import { PoCutoffControl } from "./po-cutoff-control";
import { RerunResolvedButton } from "./rerun-resolved-button";

export const dynamic = "force-dynamic";

// Display order for the EAN queue chips.
const EAN_ORDER = [
  "PENDING",
  "RESOLVING",
  "PARTIAL",
  "RESOLVED",
  "PO_FOUND_NO_EANS",
  "PO_NOT_FOUND",
  "ERROR",
  "NONE",
] as const;

const JOB_ORDER = ["QUEUED", "RUNNING", "AWAITING_REVIEW", "APPROVED", "REJECTED", "FAILED"] as const;

const STYLE_ORDER = [
  "PENDING",
  "READY",
  "GENERATING",
  "AWAITING_REVIEW",
  "APPROVED",
  "REJECTED",
] as const;

// Automation activity. Shows whether the Railway cron is actually landing
// (recent runs + what each did), the current queue depths, and a "Run now"
// button to drain on demand — the diagnostic home for "why are things still
// queued?". The cron pokes POST /api/po-eans/run?sweep=1 and
// POST /api/jobs/run?sweep=1; both record a row here when run by cron or "Run now".
export const metadata = { title: "Automation" };

export default async function AutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  await requireAdminPage();

  const minPo = await getAutomationMinPo();
  const showAll = (await searchParams).show === "all";

  // A run "did something" when any counter moved. The default log shows only
  // these — hiding the idle/skipped cron ticks that otherwise read "0 0 0".
  const activityWhere = {
    OR: [
      { processed: { gt: 0 } },
      { failed: { gt: 0 } },
      { requeued: { gt: 0 } },
      { enqueued: { gt: 0 } },
    ],
  };

  const [
    autoScrape,
    autoGen,
    eanGroups,
    floatedEan,
    jobGroups,
    runs,
    activeQueued,
    lastFired,
    activityCount,
    totalCount,
    styleGroups,
    readyToGen,
    generatedStyles,
    rerunnableResolved,
  ] = await Promise.all([
    getPoEanAutoRunEnabled(),
    getAutoGenerateEnabled(),
    db.style.groupBy({
      by: ["eanStatus"],
      where: { poNumber: { not: null } },
      _count: { _all: true },
    }),
    db.style.count({
      where: {
        poNumber: { not: null },
        eanStatus: { in: ["ERROR", "PO_NOT_FOUND", "PO_FOUND_NO_EANS"] },
        eanAttempts: { gte: MAX_EAN_ATTEMPTS },
      },
    }),
    db.job.groupBy({ by: ["status"], _count: { _all: true } }),
    db.cronRun.findMany({
      where: showAll ? undefined : activityWhere,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    // PENDING at/above the PO cutoff — what auto-scrape will actually touch.
    db.style.count({
      where: {
        poNumber: { not: null },
        eanStatus: "PENDING",
        ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
      },
    }),
    // Heartbeat: when each kind last fired at all (incl. idle ticks), so the
    // activity-only log still proves the cron is reaching the app.
    db.cronRun.groupBy({ by: ["kind"], _max: { createdAt: true } }),
    db.cronRun.count({ where: activityWhere }),
    db.cronRun.count(),
    db.style.groupBy({ by: ["status"], _count: { _all: true } }),
    // "Ready to generate": complete styles on an active prod spec with no job
    // in flight — the backlog the sweep would pick up next. (Partial styles
    // whose own ready outputs trickle in are generated too, but counting those
    // needs the per-output readiness walk, too costly for a page load.)
    db.style.count({
      where: {
        status: "READY",
        prodSpec: { is: { active: true } },
        jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
      },
    }),
    // "Styles generated": at least one output produced (a non-FAILED asset).
    db.style.count({
      where: { jobs: { some: { status: { not: "FAILED" }, assets: { some: {} } } } },
    }),
    // Already-resolved styles the "Re-run resolved" button would re-queue —
    // bounded by the PO cutoff so the count matches what actually re-runs.
    db.style.count({
      where: {
        poNumber: { not: null },
        eanStatus: { in: ["RESOLVED", "PARTIAL"] },
        ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
      },
    }),
  ]);

  const eanCounts = new Map(eanGroups.map((g) => [g.eanStatus as string, g._count._all]));
  const jobCounts = new Map(jobGroups.map((g) => [g.status as string, g._count._all]));
  const styleCounts = new Map(styleGroups.map((g) => [g.status as string, g._count._all]));
  const queued = eanCounts.get("PENDING") ?? 0;
  // Below-cutoff PENDING — sitting parked, NOT auto-scraped.
  const parkedQueued = Math.max(queued - activeQueued, 0);
  // Last-fired per kind from the heartbeat query (independent of the activity
  // filter, so it stays accurate even when every recent tick was a no-op).
  const lastFiredByKind = new Map(lastFired.map((g) => [g.kind, g._max.createdAt]));
  const lastEan = lastFiredByKind.get("po-eans") ?? null;
  const lastGen = lastFiredByKind.get("jobs") ?? null;
  const hiddenCount = totalCount - activityCount;

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automation</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            What the cron has done and the current queue depth. The Railway cron pokes the EAN
            scrape and the generation sweep on a schedule; if barcodes or outputs are stuck, this is
            where to look. <strong>Run now</strong> fires the same work immediately (signed-in, so it
            ignores the auto-run switch for scraping).
          </p>
        </div>
        <RunNowButton />
      </div>

      {/* Switch + headline state */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StateCard
          label="Automatic barcode scraping"
          on={autoScrape}
          hint={autoScrape ? "cron drains the EAN queue" : "cron no-ops; drain from /po-eans"}
        />
        <StateCard
          label="Automatic generation"
          on={autoGen}
          hint={autoGen ? "ready styles auto-generate" : "no auto-generation"}
        />
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-sm font-semibold text-zinc-900">Barcodes queued</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900">{activeQueued}</span>
            <span className="text-xs text-zinc-400">active{minPo !== null ? ` (PO ≥ ${minPo})` : ""}</span>
          </div>
          <div className="mt-1 text-xs text-zinc-400">
            {parkedQueued > 0 ? (
              <>
                + <span className="tabular-nums">{parkedQueued.toLocaleString()}</span> parked backlog
                (not auto-scraped)
              </>
            ) : activeQueued === 0 ? (
              "queue empty"
            ) : lastEan ? (
              `last EAN run ${formatDate(lastEan)}`
            ) : (
              "no recorded EAN run yet — is the cron hitting the app?"
            )}
          </div>
        </div>
      </div>

      {/* PO cutoff control */}
      <div className="mb-6">
        <PoCutoffControl initialCutoff={minPo} parkedCount={parkedQueued} />
      </div>

      {/* Generation backlog — how many styles are waiting vs. already produced */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Ready to generate"
          value={readyToGen}
          hint="complete styles awaiting their first run"
        />
        <StatCard
          label="Generating now"
          value={styleCounts.get("GENERATING") ?? 0}
          hint="a job is in flight"
        />
        <StatCard
          label="In review"
          value={styleCounts.get("AWAITING_REVIEW") ?? 0}
          hint="generated, awaiting a decision"
        />
        <StatCard
          label="Styles generated"
          value={generatedStyles}
          hint="≥ 1 output produced (first print done)"
        />
      </div>

      {/* Queue depths */}
      <div className="mb-6 grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-900">EAN queue</h2>
            {/* Re-queue every resolved style so the runner re-scrapes it with
                the latest matching logic (the sweep never re-touches resolved
                rows). Bounded by the PO cutoff, same as auto-scrape. */}
            <RerunResolvedButton count={rerunnableResolved} cutoff={minPo} />
          </div>
          {/* Each chip deep-links to /po-eans filtered to that set, where the
              rows can be re-resolved (the gave-up set in bulk). */}
          <div className="flex flex-wrap gap-2">
            {floatedEan > 0 && (
              <Link
                href="/po-eans?floated=1"
                className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-red-500"
              >
                gave up <span className="tabular-nums">{floatedEan}</span>
              </Link>
            )}
            {EAN_ORDER.filter((s) => (eanCounts.get(s) ?? 0) > 0).map((s) => {
              const m = eanStatusMeta(s);
              return (
                <Link
                  key={s}
                  href={`/po-eans?status=${s}`}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium hover:opacity-80 ${m.cls}`}
                >
                  {m.label} <span className="tabular-nums opacity-70">{eanCounts.get(s)}</span>
                </Link>
              );
            })}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-zinc-900">Generation jobs</h2>
          <div className="flex flex-wrap gap-2">
            {JOB_ORDER.filter((s) => (jobCounts.get(s) ?? 0) > 0).map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
              >
                {s.toLowerCase().replace(/_/g, " ")}{" "}
                <span className="tabular-nums opacity-70">{jobCounts.get(s)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Styles by status — the whole pipeline at a glance */}
      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-900">Styles by status</h2>
        <div className="flex flex-wrap gap-2">
          {STYLE_ORDER.filter((s) => (styleCounts.get(s) ?? 0) > 0).map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
            >
              {s.toLowerCase().replace(/_/g, " ")}{" "}
              <span className="tabular-nums opacity-70">{styleCounts.get(s)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Recent runs */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">
          Recent runs{showAll ? "" : " with activity"}
        </h2>
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span>
            EAN scrape {lastEan ? `last fired ${formatDate(lastEan)}` : "never fired"} · Generation{" "}
            {lastGen ? `last fired ${formatDate(lastGen)}` : "never fired"}
          </span>
          <Link
            href={showAll ? "/automation" : "/automation?show=all"}
            className="rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-600 hover:bg-zinc-50"
          >
            {showAll
              ? "Activity only"
              : `Show all${hiddenCount > 0 ? ` (+${hiddenCount} idle)` : ""}`}
          </Link>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">What</th>
              <th className="px-4 py-3">By</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-400">
                  {!showAll && hiddenCount > 0 ? (
                    <>
                      No runs with activity yet — the cron has fired {hiddenCount} idle tick
                      {hiddenCount === 1 ? "" : "s"} with nothing to do.{" "}
                      <Link href="/automation?show=all" className="underline">
                        Show all
                      </Link>{" "}
                      to see them.
                    </>
                  ) : (
                    <>
                      No runs recorded yet. Once the Railway cron hits the app (or you press Run now),
                      ticks show here. An empty list with a full queue means the cron isn&rsquo;t
                      reaching the app.
                    </>
                  )}
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100">
                <td className="px-4 py-2 whitespace-nowrap text-zinc-600">{formatDate(r.createdAt)}</td>
                <td className="px-4 py-2 font-medium">
                  {r.kind === "po-eans" ? "EAN scrape" : "Generation"}
                </td>
                <td className="px-4 py-2 text-zinc-500">{r.source === "secret" ? "cron" : "manual"}</td>
                <td className="px-4 py-2 text-zinc-600">
                  {r.skipped ? (
                    <span className="text-amber-700">skipped{r.note ? ` — ${r.note}` : ""}</span>
                  ) : (
                    <span className="tabular-nums">
                      {r.kind === "po-eans"
                        ? `resolved ${r.processed} · requeued ${r.requeued} · failed ${r.failed}`
                        : `enqueued ${r.enqueued} · rendered ${r.processed} · failed ${r.failed}`}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums text-zinc-400">
                  {r.durationMs == null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="text-sm font-semibold text-zinc-900">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</div>
      <div className="mt-1 text-xs text-zinc-400">{hint}</div>
    </div>
  );
}

function StateCard({ label, on, hint }: { label: string; on: boolean; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="text-sm font-semibold text-zinc-900">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
            on ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-600"
          }`}
        >
          {on ? "ON" : "OFF"}
        </span>
        <span className="text-xs text-zinc-400">{hint}</span>
      </div>
    </div>
  );
}
