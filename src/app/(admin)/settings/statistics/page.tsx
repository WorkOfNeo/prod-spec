import Link from "next/link";
import { requireAdminPage } from "@/lib/auth-server";
import {
  getReviewStats,
  formatDuration,
  type StatsWindow,
  type CompletedOutput,
} from "@/lib/dashboard/review-stats";

export const dynamic = "force-dynamic";

// Admin-only review analytics, measured PER OUTPUT. The headline question —
// "how long does an output take from generated to reviewed" — sits in the top
// cards; the per-reviewer table and the recent list break it down. Derived
// from JobAsset decisions, so it keeps working when outputs are reviewed
// independently and a job never fully settles.

const WINDOWS: { value: StatsWindow; label: string }[] = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
  { value: "all", label: "All time" },
];

function parseWindow(raw: string | undefined): StatsWindow {
  if (raw === "all") return "all";
  if (raw === "30") return 30;
  if (raw === "365") return 365;
  return 90;
}

function fmtWhen(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function reviewerLabel(r: { reviewerName: string | null; reviewerEmail: string | null }): string {
  return r.reviewerName ?? r.reviewerEmail ?? "—";
}

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdminPage();

  const sp = await searchParams;
  const window = parseWindow(sp.days);
  const stats = await getReviewStats({ days: window });

  return (
    <div className="px-8 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review statistics</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            How long each output takes from generated to reviewed, and how each reviewer is doing.
            Counted per output (document), decided = approved or rejected.
          </p>
        </div>
        <nav className="flex shrink-0 gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
          {WINDOWS.map((w) => {
            const active = w.value === window;
            const href = `/settings/statistics?days=${w.value}`;
            return (
              <Link
                key={String(w.value)}
                href={href}
                className={`rounded-md px-3 py-1 text-sm transition ${
                  active
                    ? "bg-white font-medium text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                {w.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {stats.totalOutputs === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-16 text-center">
          <p className="text-sm font-medium text-zinc-700">No outputs reviewed in this window.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Once outputs are approved or rejected, their timing and outcomes show up here.
          </p>
        </div>
      ) : (
        <>
          {/* Headline cards */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Outputs reviewed"
              value={String(stats.totalOutputs)}
              hint="decided documents in this window"
            />
            <StatCard
              label="Median time to review"
              value={formatDuration(stats.medianDurationMs)}
              hint={`Average ${formatDuration(stats.avgDurationMs)} · generated → decided`}
              accent
            />
            <StatCard
              label="Slowest 10% (p90)"
              value={formatDuration(stats.p90DurationMs)}
              hint={
                stats.longest
                  ? `Longest ${formatDuration(stats.longest.durationMs)} · ${stats.longest.outputName}`
                  : "—"
              }
            />
            <StatCard
              label="Approval rate"
              value={pct(stats.approvalRate)}
              hint={`${stats.totalApproved} approved · ${stats.totalRejected} rejected`}
            />
          </div>

          {/* Rework load */}
          {stats.rework && (stats.rework.openTickets > 0 || stats.rework.reopened > 0) && (
            <p className="mt-4 text-sm text-zinc-500">
              Current rework load:{" "}
              <span className="font-medium text-zinc-700">{stats.rework.openTickets}</span> open
              rejection ticket(s)
              {stats.rework.reopened > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-amber-700">{stats.rework.reopened}</span> came
                  back after a fix
                </>
              )}
              {" · "}
              <Link href="/settings/rejection-log" className="text-blue-700 hover:underline">
                open rejection log →
              </Link>
            </p>
          )}

          {/* Per-reviewer */}
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-zinc-900">By reviewer</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Each output a reviewer decided counts once; time is generated → decided.
            </p>
            <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Reviewer</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Outputs</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Approved</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Rejected</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Approval&nbsp;%</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Median time</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Avg time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {stats.reviewers.map((r) => (
                    <tr key={r.userId} className="hover:bg-zinc-50">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-zinc-900">{r.name ?? r.email ?? "—"}</div>
                        {r.name && r.email && (
                          <div className="text-xs text-zinc-400">{r.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.outputsReviewed}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">
                        {r.approved}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-red-700">
                        {r.rejected}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{pct(r.approvalRate)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatDuration(r.medianDurationMs)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500">
                        {formatDuration(r.avgDurationMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Recent decided outputs */}
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-zinc-900">Recent reviewed outputs</h2>
            <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold">Style</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Output</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Reviewer</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Generated</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Decided</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Duration</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {stats.recent.map((r, i) => (
                    <RecentRow key={`${r.styleId}-${r.outputName}-${i}`} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
            {stats.capped && (
              <p className="mt-2 text-xs text-zinc-400">
                Showing the most recent 1,000 reviewed outputs in this window — older rows are omitted
                from the totals.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent ? "border-blue-200 bg-blue-50/50" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

function RecentRow({ r }: { r: CompletedOutput }) {
  return (
    <tr className="hover:bg-zinc-50">
      <td className="px-4 py-2.5">
        <div className="font-medium text-zinc-900">{r.styleName}</div>
        <div className="text-xs text-zinc-400">{r.customerName}</div>
      </td>
      <td className="px-4 py-2.5 text-zinc-600">{r.outputName}</td>
      <td className="px-4 py-2.5 text-zinc-600">{reviewerLabel(r)}</td>
      <td className="px-4 py-2.5 text-zinc-500">{fmtWhen(r.openedAt)}</td>
      <td className="px-4 py-2.5 text-zinc-500">{fmtWhen(r.finishedAt)}</td>
      <td className="px-4 py-2.5 text-right font-medium tabular-nums text-zinc-900">
        {formatDuration(r.durationMs)}
      </td>
      <td className="px-4 py-2.5 text-right">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
            r.outcome === "APPROVED"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {r.outcome === "APPROVED" ? "Approved" : "Rejected"}
        </span>
      </td>
    </tr>
  );
}
