import Link from "next/link";
import { requireAdminPage } from "@/lib/auth-server";
import { getReviewActivity, type ReviewActivityRow } from "@/lib/dashboard/review-activity";

export const dynamic = "force-dynamic";

// Super-admin review reporting (T2): per-review start → end by reviewer.
// Admin-only — it exposes who reviewed what across every customer.

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_STYLE: Record<string, string> = {
  AWAITING_REVIEW: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
  FAILED: "bg-red-50 text-red-700",
  QUEUED: "bg-zinc-100 text-zinc-600",
  RUNNING: "bg-blue-50 text-blue-700",
};

function formatDuration(start: Date, end: Date | null): string {
  if (!end) return "—";
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function endLabel(row: ReviewActivityRow): string {
  if (row.endedAt) return STAMP.format(row.endedAt);
  // No end yet: distinguish "still being reviewed" from "settled but the end
  // stamp hasn't been written" (the write lands in the approval track).
  return row.status === "AWAITING_REVIEW" ? "in progress" : "—";
}

export const metadata = { title: "Review activity" };

export default async function ReviewActivityPage() {
  await requireAdminPage();
  const { rows, endColumnMissing } = await getReviewActivity();

  return (
    <div className="px-6 py-5">
      <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Review activity</h1>
      <p className="text-sm text-muted">
        Every claimed review, newest first — who started it, when, and how long it took. Start is
        stamped when a reviewer opens or claims a review; end is stamped when the job settles.
      </p>

      {endColumnMissing ? (
        <div className="mt-4 rounded-lg border border-transparent bg-warn-soft p-3 text-xs text-warn">
          The <code>reviewEndedAt</code> column isn&rsquo;t deployed yet — run{" "}
          <code>npm run db:deploy</code> to apply the migration. End times stay blank until then.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="mt-6 rounded-xl border border-line bg-surface p-8 text-center">
          <div className="text-sm font-semibold text-ink">No reviews started yet.</div>
          <p className="mt-1 text-sm text-muted">
            A row appears here once a reviewer claims or opens a review.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle text-left text-[11px] text-muted">
                <th className="px-4 py-2 font-semibold">Style</th>
                <th className="px-4 py-2 font-semibold">Customer</th>
                <th className="px-4 py-2 font-semibold">Business area</th>
                <th className="px-4 py-2 font-semibold">Reviewer</th>
                <th className="px-4 py-2 font-semibold">Started</th>
                <th className="px-4 py-2 font-semibold">Ended</th>
                <th className="px-4 py-2 font-semibold">Duration</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.jobId} className="border-t border-line hover:bg-zinc-50/60">
                  <td className="px-4 py-2">
                    <Link
                      href={`/styles/${r.styleId}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {r.styleName}
                    </Link>
                    {r.poNumber ? (
                      <span className="ml-2 text-xs text-muted">PO {r.poNumber}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-muted">{r.customerName}</td>
                  <td className="px-4 py-2 text-muted">{r.businessArea ?? "—"}</td>
                  <td data-private className="px-4 py-2 text-ink">{r.reviewerName ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-muted">{STAMP.format(r.startedAt)}</td>
                  <td className="px-4 py-2 text-xs text-muted">{endLabel(r)}</td>
                  <td className="px-4 py-2 text-xs tabular-nums text-ink">
                    {formatDuration(r.startedAt, r.endedAt)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        STATUS_STYLE[r.status] ?? "bg-subtle text-muted"
                      }`}
                    >
                      {r.status.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
