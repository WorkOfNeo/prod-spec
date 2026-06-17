import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/lib/auth-server";
import {
  getPoEanAutoRunEnabled,
  getAutoGenerateEnabled,
  getAutomationWindowDays,
  getAutomationWindowCutoff,
} from "@/lib/settings/app-settings";
import { eanStatusMeta, MAX_EAN_ATTEMPTS } from "@/lib/po/ean-status-meta";
import { RunNowButton } from "./run-now-button";
import { WindowControl } from "./window-control";

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

// Automation activity. Shows whether the Railway cron is actually landing
// (recent runs + what each did), the current queue depths, and a "Run now"
// button to drain on demand — the diagnostic home for "why are things still
// queued?". The cron pokes POST /api/po-eans/run?sweep=1 and
// POST /api/jobs/run?sweep=1; both record a row here when run by cron or "Run now".
export default async function AutomationPage() {
  await requireAdminPage();

  const windowDays = await getAutomationWindowDays();
  const windowCutoff = await getAutomationWindowCutoff();

  const [autoScrape, autoGen, eanGroups, floatedEan, jobGroups, runs, activeQueued] =
    await Promise.all([
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
      db.cronRun.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      // PENDING within the recent window — what auto-scrape will actually touch.
      db.style.count({
        where: {
          poNumber: { not: null },
          eanStatus: "PENDING",
          ...(windowCutoff ? { eanQueuedAt: { gte: windowCutoff } } : {}),
        },
      }),
    ]);

  const eanCounts = new Map(eanGroups.map((g) => [g.eanStatus as string, g._count._all]));
  const jobCounts = new Map(jobGroups.map((g) => [g.status as string, g._count._all]));
  const queued = eanCounts.get("PENDING") ?? 0;
  // Out-of-window PENDING — sitting parked, NOT auto-scraped.
  const parkedQueued = Math.max(queued - activeQueued, 0);
  const lastRunByKind = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!lastRunByKind.has(r.kind)) lastRunByKind.set(r.kind, r);

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
            <span className="text-xs text-zinc-400">active{windowDays > 0 ? ` (last ${windowDays}d)` : ""}</span>
          </div>
          <div className="mt-1 text-xs text-zinc-400">
            {parkedQueued > 0 ? (
              <>
                + <span className="tabular-nums">{parkedQueued.toLocaleString()}</span> parked backlog
                (not auto-scraped)
              </>
            ) : activeQueued === 0 ? (
              "queue empty"
            ) : lastRunByKind.has("po-eans") ? (
              `last EAN run ${formatDate(lastRunByKind.get("po-eans")!.createdAt)}`
            ) : (
              "no recorded EAN run yet — is the cron hitting the app?"
            )}
          </div>
        </div>
      </div>

      {/* Recent-window control */}
      <div className="mb-6">
        <WindowControl initialDays={windowDays} parkedCount={parkedQueued} />
      </div>

      {/* Queue depths */}
      <div className="mb-6 grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-zinc-900">EAN queue</h2>
          <div className="flex flex-wrap gap-2">
            {floatedEan > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                gave up <span className="tabular-nums">{floatedEan}</span>
              </span>
            )}
            {EAN_ORDER.filter((s) => (eanCounts.get(s) ?? 0) > 0).map((s) => {
              const m = eanStatusMeta(s);
              return (
                <span
                  key={s}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}
                >
                  {m.label} <span className="tabular-nums opacity-70">{eanCounts.get(s)}</span>
                </span>
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

      {/* Recent runs */}
      <h2 className="mb-2 text-sm font-semibold text-zinc-900">Recent runs</h2>
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
                  No runs recorded yet. Once the Railway cron hits the app (or you press Run now),
                  ticks show here. An empty list with a full queue means the cron isn&rsquo;t reaching
                  the app.
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
