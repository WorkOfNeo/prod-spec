import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { formatDuration } from "@/lib/dashboard/review-stats";
import {
  getReviewerDashboard,
  getReviewerDashboardOptions,
  BUCKET_LABELS,
  STYLE_BUCKETS,
  type DurationStat,
  type ReviewerDashboard,
  type StyleBucket,
} from "@/lib/dashboard/reviewer-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review dashboard" };

// The reviewer's own dashboard — REVIEWER-reachable (canReview), deliberately
// NOT under /settings (that nav is admin-only).
//
// Why this is a separate screen and not an extension of
// /settings/style-dashboard: that surface is admin-only and answers a DELIVERY
// question (generated → uploaded to SharePoint → emailed to the supplier), one
// row per style with per-output expansion. This one answers a REVIEW question
// (where does each order stand, how long does each step take, how often is it
// right first time) and has to be reachable by a reviewer. Merging them would
// mean either exposing the delivery/SharePoint machinery to reviewers or
// hiding the review metrics behind an admin gate. /settings/statistics stays
// as-is too: it measures the OUTPUT (per-document cycle time, per reviewer);
// this measures the ORDER.

type SP = {
  customer?: string;
  supplier?: string;
  reviewer?: string;
  from?: string;
  to?: string;
};

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function rateLabel(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

// ---- Small presentational pieces -------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-gray-500">{sub}</div> : null}
    </div>
  );
}

function DurationCard({ label, stat, hint }: { label: string; stat: DurationStat; hint: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{formatDuration(stat.medianMs)}</div>
      <div className="mt-0.5 text-xs text-gray-500">
        median · avg {formatDuration(stat.avgMs)} · {stat.n} order{stat.n === 1 ? "" : "s"}
      </div>
      <div className="mt-1 text-[11px] leading-tight text-gray-400">{hint}</div>
    </div>
  );
}

const SEGMENT_COLOURS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-rose-500"];

// A single 100%-wide stacked bar. Segments with a 0 count are dropped so the
// bar never renders a sliver you can't read.
function PercentBar({ segments }: { segments: { label: string; count: number }[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-400">
        Nothing measurable in this scope yet
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded-md">
        {segments.map((s, i) =>
          s.count === 0 ? null : (
            <div
              key={s.label}
              className={`${SEGMENT_COLOURS[i % SEGMENT_COLOURS.length]} flex items-center justify-center`}
              style={{ width: `${(s.count / total) * 100}%` }}
              title={`${s.label}: ${s.count} of ${total}`}
            >
              <span className="px-1 text-[11px] font-medium text-white">{pct(s.count, total)}%</span>
            </div>
          ),
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
        {segments.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className={`${SEGMENT_COLOURS[i % SEGMENT_COLOURS.length]} inline-block h-2 w-2 rounded-sm`}
            />
            {s.label} · {s.count}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {note ? <p className="mt-0.5 max-w-3xl text-xs text-gray-500">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// ---- Page -------------------------------------------------------------------

export default async function ReviewDashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/");

  const sp = await searchParams;
  const filters = {
    customerId: sp.customer || null,
    supplierId: sp.supplier || null,
    reviewerId: sp.reviewer || null,
    from: parseDate(sp.from),
    // An end date from a <input type="date"> means "the whole of that day".
    to: (() => {
      const d = parseDate(sp.to);
      if (!d) return null;
      d.setUTCHours(23, 59, 59, 999);
      return d;
    })(),
  };

  const [options, { data }] = await Promise.all([
    getReviewerDashboardOptions(),
    getReviewerDashboard(filters),
  ]);

  const filtered = Boolean(
    filters.customerId || filters.supplierId || filters.reviewerId || filters.from || filters.to,
  );

  return (
    <div className="px-8 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Review dashboard</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Every order in the active book, where it stands in review, and how long each step takes.
            One order = one style. Use the filters to scope every card below.
          </p>
        </div>
        <Link href="/reviews" className="text-sm text-blue-600 hover:underline">
          ← Back to reviews
        </Link>
      </div>

      {/* Item 2 — filters. A plain GET form: no client JS, bookmarkable, and
          every card on the page reads the same scope. */}
      <form method="GET" className="mt-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Client</span>
            <select
              name="customer"
              defaultValue={sp.customer ?? ""}
              className="min-w-48 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">All clients</option>
              {options.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Supplier</span>
            <select
              name="supplier"
              defaultValue={sp.supplier ?? ""}
              className="min-w-48 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">All suppliers</option>
              {options.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Person reviewing</span>
            <select
              name="reviewer"
              defaultValue={sp.reviewer ?? ""}
              className="min-w-40 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">Everyone</option>
              {options.reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Decisions from</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? ""}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">to</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to ?? ""}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Apply
          </button>
          {filtered ? (
            <Link
              href="/reviews/dashboard"
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {/* Item 1 — where every order stands. */}
      <Section
        title={`Orders in scope · ${data.totalStyles.toLocaleString("en-GB")}`}
        note={
          "Active styles only (has a PO number, not archived, not in a hidden Monday group) — the same set the /styles list shows. " +
          "“Waiting for customer info” means no generation has ever been enqueued for the order, which is what the Needs-input tab lists."
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {STYLE_BUCKETS.map((b: StyleBucket) => (
            <StatCard
              key={b}
              label={BUCKET_LABELS[b]}
              value={data.buckets[b].toLocaleString("en-GB")}
              sub={`${pct(data.buckets[b], data.totalStyles)}% of scope`}
            />
          ))}
        </div>
      </Section>

      {/* Item 3 — step timings. */}
      <Section
        title="Average time per step"
        note="Median is the headline (a handful of very old orders drags the average up); the average and the sample size sit underneath."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DurationCard
            label="Creation → first review"
            stat={data.timings.creationToFirstReview}
            hint="First generation of the order to the first output decision on it."
          />
          <DurationCard
            label="First review → regeneration"
            stat={data.timings.firstReviewToRegeneration}
            hint="First rejection to the next generation — how fast a rejection gets answered."
          />
          <DurationCard
            label="First review → final approval"
            stat={data.timings.firstReviewToFinalApproval}
            hint="First decision to the last one, for orders that reached fully approved."
          />
        </div>
      </Section>

      {/* Item 4 — first-pass rate. */}
      <Section
        title="Approved first time"
        note="Share of orders whose FIRST generation was approved with no rejection, by when that first round was decided."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.firstPass.map((w) => (
            <div key={w.label} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {w.label}
                </span>
                <span className="text-sm font-semibold text-gray-900">
                  {w.total > 0 ? `${pct(w.clean, w.total)}%` : "—"}
                </span>
              </div>
              <div className="mt-2">
                <PercentBar
                  segments={[
                    { label: "First time", count: w.clean },
                    { label: "Needed a redo", count: w.total - w.clean },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Item 5 — turnaround. */}
      <Section
        title="Time to full approval"
        note="Orders that reached fully approved, measured from their first generation to the last approval."
      >
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
          <PercentBar
            segments={[
              { label: "Within 1 day", count: data.turnaround.within1d },
              { label: "Within 2 days", count: data.turnaround.within2d },
              { label: "Under a week", count: data.turnaround.withinWeek },
              { label: "Over a week", count: data.turnaround.overWeek },
            ]}
          />
          <div className="mt-2 text-xs text-gray-500">
            {data.turnaround.total.toLocaleString("en-GB")} fully approved order
            {data.turnaround.total === 1 ? "" : "s"} in scope.
          </div>
        </div>
      </Section>

      {/* Item 6 — activity in the chosen range. */}
      <Section
        title="Reviewed in this date range"
        note={
          filters.from || filters.to
            ? "Output decisions stamped inside the chosen range" +
              (filters.reviewerId ? ", by the chosen reviewer." : ".")
            : "No range chosen — this counts every decision on record in scope. Pick dates above to narrow it."
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Outputs decided" value={data.range.reviewed.toLocaleString("en-GB")} />
          <StatCard
            label="Approved"
            value={data.range.approved.toLocaleString("en-GB")}
            sub={`${pct(data.range.approved, data.range.reviewed)}% of decisions`}
          />
          <StatCard
            label="Rejected"
            value={data.range.rejected.toLocaleString("en-GB")}
            sub={`${pct(data.range.rejected, data.range.reviewed)}% of decisions`}
          />
          <StatCard label="Orders touched" value={data.range.styles.toLocaleString("en-GB")} />
        </div>
      </Section>

      {/* Item 7 — per-client. */}
      <Section
        title="Efficiency per client"
        note="“Efficiency” is spelled out rather than rolled into one score: how often a client's orders are right first time, how long they take end to end, and how much of the review work on them ends in approval."
      >
        <ClientTable data={data} />
      </Section>
    </div>
  );
}

function ClientTable({ data }: { data: ReviewerDashboard }) {
  if (data.clients.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
        No orders in scope.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 bg-white text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Client</th>
            <th className="px-4 py-2 text-right font-medium">Orders</th>
            <th className="px-4 py-2 text-right font-medium">Fully reviewed</th>
            <th className="px-4 py-2 text-right font-medium">First time right</th>
            <th className="px-4 py-2 text-right font-medium">Median turnaround</th>
            <th className="px-4 py-2 text-right font-medium">Approval rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.clients.map((c) => (
            <tr key={c.customerId} className="hover:bg-gray-50">
              <td className="px-4 py-2 text-gray-900">{c.customerName}</td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                {c.styles.toLocaleString("en-GB")}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                {c.fullyReviewed.toLocaleString("en-GB")}
                <span className="ml-1 text-xs text-gray-400">({pct(c.fullyReviewed, c.styles)}%)</span>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                {rateLabel(c.firstPassRate)}
                {c.firstPassTotal > 0 ? (
                  <span className="ml-1 text-xs text-gray-400">
                    ({c.firstPassClean}/{c.firstPassTotal})
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                {formatDuration(c.medianTurnaroundMs)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                {rateLabel(c.approvalRate)}
                {c.decided > 0 ? (
                  <span className="ml-1 text-xs text-gray-400">({c.decided} decided)</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
