import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { requireAdminPage } from "@/lib/auth-server";
import {
  getAutomationMinPo,
  getGenerationMinPo,
  getGenerationMinPoExplicit,
  getSupplierSendMinPo,
} from "@/lib/settings/app-settings";
import { eanStatusMeta } from "@/lib/po/ean-status-meta";
import { getPipelineSnapshot } from "@/lib/automation/pipeline";
import {
  FEED_KIND_LABELS,
  getAutomationFeed,
  type FeedEvent,
  type FeedKind,
} from "@/lib/automation/feed";
import { RunNowButton } from "./run-now-button";
import { PoCutoffControl } from "./po-cutoff-control";
import { GenerationCutoffControl } from "./generation-cutoff-control";
import { RerunResolvedButton } from "./rerun-resolved-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation" };

// The automation control tower, three tabs:
//   Pipeline — the funnel: where every style sits between "PO landed" and
//              "sent to the supplier", with the gave-up floats per stage.
//   Activity — one chronological feed over every run record (crons, Monday
//              syncs, digest batches, bulk runs, emails).
//   Settings — the cutoffs + master-switch overview (the supplier toggle
//              itself lives on /settings/approved, linked).
// "Run now" fires the scrape + generation sweep immediately, as before.

const EAN_ORDER = [
  "PENDING",
  "RESOLVING",
  "PARTIAL",
  "RESOLVED",
  "RESOLVED_FROM_MONDAY",
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

const FEED_KINDS = Object.keys(FEED_KIND_LABELS) as FeedKind[];

type TabKey = "pipeline" | "activity" | "settings";

export default async function AutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; show?: string; feed?: string }>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const tab: TabKey =
    params.tab === "activity" ? "activity" : params.tab === "settings" ? "settings" : "pipeline";

  return (
    <div className="px-8 py-8">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automation</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            The full pipeline — Monday sync → barcodes → generation → review → SharePoint → supplier
            digest. <strong>Run now</strong> fires the scrape and generation sweep immediately.
          </p>
        </div>
        <RunNowButton />
      </div>

      <nav className="mb-6 border-b border-zinc-200">
        <ul className="flex gap-1">
          {(
            [
              { key: "pipeline", label: "Pipeline" },
              { key: "activity", label: "Activity" },
              { key: "settings", label: "Settings" },
            ] as { key: TabKey; label: string }[]
          ).map((t) => (
            <li key={t.key}>
              <Link
                href={`/automation?tab=${t.key}`}
                scroll={false}
                className={`inline-block border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "pipeline" && <PipelineTab />}
      {tab === "activity" && (
        <ActivityTab showAll={params.show === "all"} feedKind={params.feed as FeedKind | undefined} />
      )}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}

// ---------------------------------------------------------------- Pipeline

async function PipelineTab() {
  const [snapshot, eanGroups, jobGroups, styleGroups, rerunnableResolved, minPo] =
    await Promise.all([
      getPipelineSnapshot(),
      db.style.groupBy({
        by: ["eanStatus"],
        where: { poNumber: { not: null } },
        _count: { _all: true },
      }),
      db.job.groupBy({ by: ["status"], _count: { _all: true } }),
      db.style.groupBy({ by: ["status"], _count: { _all: true } }),
      db.style.count({
        where: {
          poNumber: { not: null },
          eanStatus: { in: ["RESOLVED", "PARTIAL"] },
        },
      }),
      getAutomationMinPo(),
    ]);

  const eanCounts = new Map(eanGroups.map((g) => [g.eanStatus as string, g._count._all]));
  const jobCounts = new Map(jobGroups.map((g) => [g.status as string, g._count._all]));
  const styleCounts = new Map(styleGroups.map((g) => [g.status as string, g._count._all]));

  return (
    <>
      {/* Master switches — is the machine even on? */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StateCard
          label="Automatic barcode scraping"
          on={snapshot.switches.autoScrape}
          hint={snapshot.switches.autoScrape ? "cron drains the EAN queue" : "cron no-ops; drain from /po-eans"}
        />
        <StateCard
          label="Automatic generation"
          on={snapshot.switches.autoGen}
          hint={snapshot.switches.autoGen ? "ready styles auto-generate" : "no auto-generation"}
        />
        <StateCard
          label="Automatic supplier sending"
          on={snapshot.switches.supplierSend}
          hint={
            snapshot.switches.supplierSend
              ? "uploads + midnight digests run"
              : "queue captures only — toggle on /settings/approved"
          }
        />
      </div>

      {/* The funnel */}
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Pipeline</h2>
        <span className="text-xs text-zinc-400">
          scoped to the automation windows
          {snapshot.genCutoff !== null ? ` · generation PO ≥ ${snapshot.genCutoff}` : ""}
          {snapshot.parkedBelowGen > 0
            ? ` · ${snapshot.parkedBelowGen.toLocaleString()} styles parked below cutoff`
            : ""}
        </span>
      </div>
      <div className="mb-6 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {snapshot.stages.map((s, i) => (
          <Link
            key={s.key}
            href={s.href}
            className={`flex items-center gap-4 px-4 py-3 hover:bg-zinc-50 ${
              i > 0 ? "border-t border-zinc-100" : ""
            }`}
          >
            <span className="w-8 text-right text-xs tabular-nums text-zinc-300">{i + 1}</span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-zinc-800">{s.label}</span>
              <span className="block text-xs text-zinc-400">{s.hint}</span>
            </span>
            {s.floated > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                gave up <span className="tabular-nums">{s.floated}</span>
              </span>
            )}
            <span className="text-xl font-semibold tabular-nums text-zinc-900">
              {s.count.toLocaleString()}
            </span>
          </Link>
        ))}
      </div>

      {/* Queue depth chips — the raw states behind the funnel */}
      <div className="mb-6 grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-900">EAN queue</h2>
            <RerunResolvedButton count={rerunnableResolved} cutoff={minPo} />
          </div>
          <div className="flex flex-wrap gap-2">
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
          <h2 className="mt-4 mb-2 text-sm font-semibold text-zinc-900">Styles by status</h2>
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
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Activity

const STATUS_PILL: Record<FeedEvent["status"], string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  skipped: "bg-amber-50 text-amber-700 border-amber-200",
  "dry-run": "bg-sky-50 text-sky-700 border-sky-200",
  running: "bg-sky-50 text-sky-700 border-sky-200",
  idle: "bg-zinc-50 text-zinc-400 border-zinc-200",
};

async function ActivityTab({ showAll, feedKind }: { showAll: boolean; feedKind?: FeedKind }) {
  const kind = feedKind && FEED_KINDS.includes(feedKind) ? feedKind : undefined;
  const [{ events, hiddenIdle }, lastFired] = await Promise.all([
    // A single-kind view is for digging ("when did uploads actually run?") —
    // fetch the full window so a kind that ticks every few minutes still shows
    // a day of history, not a couple of hours.
    getAutomationFeed({ limit: kind ? 300 : 80, kinds: kind ? [kind] : undefined, includeIdle: showAll }),
    db.cronRun.groupBy({ by: ["kind"], _max: { createdAt: true } }),
  ]);
  const lastFiredByKind = new Map(lastFired.map((g) => [g.kind, g._max.createdAt]));
  const heartbeats = [
    ["EAN scrape", lastFiredByKind.get("po-eans")],
    ["Generation", lastFiredByKind.get("jobs")],
    ["Upload sweep", lastFiredByKind.get("supplier-upload")],
  ] as const;

  const tabHref = (over: { feed?: string; show?: string }) => {
    const p = new URLSearchParams({ tab: "activity" });
    const feed = over.feed ?? kind;
    if (feed) p.set("feed", feed);
    const show = over.show ?? (showAll ? "all" : undefined);
    if (show) p.set("show", show);
    return `/automation?${p.toString()}`;
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Link
            href={`/automation?tab=activity${showAll ? "&show=all" : ""}`}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
              !kind ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            All
          </Link>
          {FEED_KINDS.map((k) => (
            <Link
              key={k}
              href={tabHref({ feed: k })}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                kind === k
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {FEED_KIND_LABELS[k]}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span>
            {heartbeats
              .map(([label, at]) => `${label} ${at ? formatDate(at) : "never"}`)
              .join(" · ")}
          </span>
          <Link
            href={showAll ? tabHref({ show: "" }) : tabHref({ show: "all" })}
            className="rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-600 hover:bg-zinc-50"
          >
            {showAll ? "Activity only" : `Show idle${hiddenIdle > 0 ? ` (+${hiddenIdle})` : ""}`}
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
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-400">
                  Nothing recorded yet{kind ? ` for ${FEED_KIND_LABELS[kind]}` : ""}. Runs land here
                  as the crons fire or operators trigger work.
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="border-t border-zinc-100 align-top">
                <td className="px-4 py-2 whitespace-nowrap text-zinc-600">{formatDate(e.at)}</td>
                <td className="px-4 py-2">
                  {e.href ? (
                    <Link href={e.href} className="font-medium text-zinc-800 hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    <span className="font-medium text-zinc-800">{e.title}</span>
                  )}
                  <span className="ml-2 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                    {FEED_KIND_LABELS[e.kind]}
                  </span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-zinc-500">{e.source}</td>
                <td className="px-4 py-2 text-zinc-600">
                  <span
                    className={`mr-2 inline-flex rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${STATUS_PILL[e.status]}`}
                  >
                    {e.status}
                  </span>
                  <span className="text-xs">{e.detail}</span>
                </td>
                <td className="px-4 py-2 whitespace-nowrap tabular-nums text-zinc-400">
                  {e.durationMs == null ? "—" : `${(e.durationMs / 1000).toFixed(1)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

async function SettingsTab() {
  const [minPo, genMinPo, genMinPoExplicit, supplierMinPo, queued] = await Promise.all([
    getAutomationMinPo(),
    getGenerationMinPo(),
    getGenerationMinPoExplicit(),
    getSupplierSendMinPo(),
    db.style.count({ where: { poNumber: { not: null }, eanStatus: "PENDING" } }),
  ]);
  // Parked = PENDING below the scrape cutoff (the PoCutoffControl caption).
  const activeQueued = await db.style.count({
    where: {
      poNumber: { not: null },
      eanStatus: "PENDING",
      ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
    },
  });
  const parkedQueued = Math.max(queued - activeQueued, 0);

  return (
    <>
      <div className="mb-6 grid gap-3 lg:grid-cols-2">
        <PoCutoffControl initialCutoff={minPo} parkedCount={parkedQueued} />
        <GenerationCutoffControl explicitCutoff={genMinPoExplicit} effectiveCutoff={genMinPo} />
      </div>
      <div className="rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-zinc-900">Supplier sending</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600">
          The master toggle, the backfill PO cutoff
          {supplierMinPo !== null ? ` (currently PO ≥ ${supplierMinPo})` : " (not set — backfill idle)"} and
          the send queue live on the delivery page.
        </p>
        <Link
          href="/settings/approved"
          className="mt-3 inline-block rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          Open Approved &amp; delivery
        </Link>
      </div>
    </>
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
