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

  const minPo = await getAutomationMinPo();

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
      // PENDING at/above the PO cutoff — what auto-scrape will actually touch.
      db.style.count({
        where: {
          poNumber: { not: null },
          eanStatus: "PENDING",
          ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
        },
      }),
    ]);

  const eanCounts = new Map(eanGroups.map((g) => [g.eanStatus as string, g._count._all]));
  const jobCounts = new Map(jobGroups.map((g) => [g.status as string, g._count._all]));
  const queued = eanCounts.get("PENDING") ?? 0;
  // Below-cutoff PENDING — sitting parked, NOT auto-scraped.
  const parkedQueued = Math.max(queued - activeQueued, 0);
  const lastRunByKind = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!lastRunByKind.has(r.kind)) lastRunByKind.set(r.kind, r);

  // Resolve the styles/jobs each shown run touched, so a run can show WHICH
  // styles it scraped and their (current) outcome — not just a count. One
  // batched lookup across all shown runs.
  const eanStyleIds = [
    ...new Set(runs.filter((r) => r.kind === "po-eans").flatMap((r) => (r.styleIds as string[]) ?? [])),
  ];
  const genJobIds = [
    ...new Set(runs.filter((r) => r.kind === "jobs").flatMap((r) => (r.jobIds as string[]) ?? [])),
  ];
  const [styleRows, jobRows] = await Promise.all([
    eanStyleIds.length
      ? db.style.findMany({
          where: { id: { in: eanStyleIds } },
          select: { id: true, name: true, poNumber: true, eanStatus: true },
        })
      : Promise.resolve([] as { id: string; name: string; poNumber: string | null; eanStatus: string }[]),
    genJobIds.length
      ? db.job.findMany({
          where: { id: { in: genJobIds } },
          select: { id: true, status: true, style: { select: { name: true, poNumber: true } } },
        })
      : Promise.resolve(
          [] as { id: string; status: string; style: { name: string; poNumber: string | null } | null }[],
        ),
  ]);
  const styleById = new Map(styleRows.map((s) => [s.id, s]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));

  // Compact "current outcomes" breakdown for a run, e.g. "3 resolved · 1 partial".
  function outcomeBreakdown(ids: string[], kind: string): string {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const status =
        kind === "po-eans" ? styleById.get(id)?.eanStatus : jobById.get(id)?.status;
      if (!status) continue;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([st, n]) =>
        kind === "po-eans"
          ? `${n} ${eanStatusMeta(st).label}`
          : `${n} ${st.toLowerCase().replace(/_/g, " ")}`,
      )
      .join(" · ");
  }

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
            ) : lastRunByKind.has("po-eans") ? (
              `last EAN run ${formatDate(lastRunByKind.get("po-eans")!.createdAt)}`
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
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Recent runs</h2>
      <p className="mb-2 text-xs text-zinc-400">
        &ldquo;processed&rdquo; = styles drained that tick (mixed outcomes, not all resolved). Expand
        a row to see which styles it touched and each one&rsquo;s current status.
      </p>
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
            {runs.map((r) => {
              const isEan = r.kind === "po-eans";
              const ids = ((isEan ? r.styleIds : r.jobIds) as string[]) ?? [];
              // "processed" not "resolved": the count is styles drained, with
              // mixed outcomes (resolved / partial / no-barcodes / not-found).
              const counts = isEan
                ? `processed ${r.processed} · requeued ${r.requeued} · failed ${r.failed}`
                : `enqueued ${r.enqueued} · rendered ${r.processed} · failed ${r.failed}`;
              const breakdown = outcomeBreakdown(ids, r.kind);
              return (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="px-4 py-2 whitespace-nowrap text-zinc-600">
                    {formatDate(r.createdAt)}
                  </td>
                  <td className="px-4 py-2 font-medium">{isEan ? "EAN scrape" : "Generation"}</td>
                  <td className="px-4 py-2 text-zinc-500">
                    {r.source === "secret" ? "cron" : "manual"}
                  </td>
                  <td className="px-4 py-2 text-zinc-600">
                    {r.skipped ? (
                      <span className="text-amber-700">skipped{r.note ? ` — ${r.note}` : ""}</span>
                    ) : ids.length === 0 ? (
                      <span className="tabular-nums">{counts}</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer tabular-nums text-zinc-700">
                          {counts}
                          {breakdown ? <span className="text-zinc-500"> — {breakdown}</span> : null}
                        </summary>
                        <ul className="mt-2 space-y-0.5 text-xs">
                          {ids.map((id) => {
                            if (isEan) {
                              const s = styleById.get(id);
                              const m = eanStatusMeta(s?.eanStatus ?? "");
                              return (
                                <li key={id} className="flex items-center gap-2">
                                  <span className="tabular-nums text-zinc-500">
                                    {s?.poNumber ?? "—"}
                                  </span>
                                  <span className="text-zinc-700">{s?.name ?? id}</span>
                                  <span
                                    className={`inline-flex rounded-full px-1.5 py-0.5 text-[11px] font-medium ${m.cls}`}
                                  >
                                    {s ? m.label : "gone"}
                                  </span>
                                </li>
                              );
                            }
                            const j = jobById.get(id);
                            return (
                              <li key={id} className="flex items-center gap-2">
                                <span className="tabular-nums text-zinc-500">
                                  {j?.style?.poNumber ?? "—"}
                                </span>
                                <span className="text-zinc-700">{j?.style?.name ?? id}</span>
                                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">
                                  {j?.status?.toLowerCase().replace(/_/g, " ") ?? "gone"}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-zinc-400">
                    {r.durationMs == null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}
                  </td>
                </tr>
              );
            })}
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
