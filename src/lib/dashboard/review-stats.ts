// =====================================================
// Review statistics — OUTPUT unit. Each decided JobAsset (one output /
// document) is a data point: "time to review" = createdAt (the output became
// available) → reviewedAt (decided). This is robust to per-output settlement:
// it never relies on a Job rolling up to APPROVED/REJECTED, so it keeps
// counting review work even when outputs are reviewed independently over time
// and a job never "fully settles". Per-output cycle time is the headline; a
// Prod-Spec rollup can layer on later (see the per-output refactor plan).
//
// computeReviewStats is pure (unit-tested); getReviewStats does the query.
// =====================================================

export type StatsOutputInput = {
  styleId: string;
  styleName: string;
  customerName: string;
  outputName: string;
  reviewStatus: "APPROVED" | "REJECTED";
  createdAt: Date; // output became available (asset generated)
  reviewedAt: Date; // decided
  reviewerId: string | null;
  reviewerEmail: string | null;
  reviewerName: string | null;
};

export type CompletedOutput = {
  styleId: string;
  styleName: string;
  customerName: string;
  outputName: string;
  reviewerId: string | null;
  reviewerEmail: string | null;
  reviewerName: string | null;
  openedAt: Date; // createdAt
  finishedAt: Date; // reviewedAt
  durationMs: number;
  outcome: "APPROVED" | "REJECTED";
};

export type ReviewerStat = {
  userId: string;
  email: string | null;
  name: string | null;
  outputsReviewed: number;
  approved: number;
  rejected: number;
  approvalRate: number | null; // approved / decided, 0..1
  avgDurationMs: number | null;
  medianDurationMs: number | null;
};

export type ReviewStats = {
  totalOutputs: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  p90DurationMs: number | null;
  longest: CompletedOutput | null;
  totalApproved: number;
  totalRejected: number;
  approvalRate: number | null; // 0..1
  reviewers: ReviewerStat[];
  recent: CompletedOutput[];
  capped: boolean;
  // Current rework load (not windowed); set by getReviewStats, null in the
  // pure path.
  rework: { openTickets: number; reopened: number } | null;
};

function toCompleted(o: StatsOutputInput): CompletedOutput {
  const durationMs = Math.max(0, o.reviewedAt.getTime() - o.createdAt.getTime());
  return {
    styleId: o.styleId,
    styleName: o.styleName,
    customerName: o.customerName,
    outputName: o.outputName,
    reviewerId: o.reviewerId,
    reviewerEmail: o.reviewerEmail,
    reviewerName: o.reviewerName,
    openedAt: o.createdAt,
    finishedAt: o.reviewedAt,
    durationMs,
    outcome: o.reviewStatus,
  };
}

export function computeReviewStats(
  outputs: StatsOutputInput[],
  opts?: { recentLimit?: number; capped?: boolean },
): ReviewStats {
  const recentLimit = opts?.recentLimit ?? 25;
  const completed = outputs.map(toCompleted);
  const durations = completed.map((c) => c.durationMs).sort((a, b) => a - b);

  let totalApproved = 0;
  let totalRejected = 0;

  type Acc = ReviewerStat & { _durations: number[] };
  const byReviewer = new Map<string, Acc>();
  const ensure = (id: string, email: string | null, name: string | null): Acc => {
    let acc = byReviewer.get(id);
    if (!acc) {
      acc = {
        userId: id,
        email,
        name,
        outputsReviewed: 0,
        approved: 0,
        rejected: 0,
        approvalRate: null,
        avgDurationMs: null,
        medianDurationMs: null,
        _durations: [],
      };
      byReviewer.set(id, acc);
    } else {
      acc.email = acc.email ?? email;
      acc.name = acc.name ?? name;
    }
    return acc;
  };

  for (const c of completed) {
    if (c.outcome === "APPROVED") totalApproved += 1;
    else totalRejected += 1;
    if (c.reviewerId) {
      const acc = ensure(c.reviewerId, c.reviewerEmail, c.reviewerName);
      acc.outputsReviewed += 1;
      if (c.outcome === "APPROVED") acc.approved += 1;
      else acc.rejected += 1;
      acc._durations.push(c.durationMs);
    }
  }

  const reviewers: ReviewerStat[] = [...byReviewer.values()]
    .map((acc) => {
      const decided = acc.approved + acc.rejected;
      const { _durations, ...rest } = acc;
      return {
        ...rest,
        approvalRate: decided > 0 ? acc.approved / decided : null,
        avgDurationMs: avg(_durations),
        medianDurationMs: median(_durations),
      };
    })
    .sort((a, b) => b.outputsReviewed - a.outputsReviewed || b.approved - a.approved);

  const longest = [...completed].sort((a, b) => b.durationMs - a.durationMs)[0] ?? null;
  const recent = [...completed]
    .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())
    .slice(0, recentLimit);

  const totalDecided = totalApproved + totalRejected;

  return {
    totalOutputs: completed.length,
    avgDurationMs: avg(durations),
    medianDurationMs: median(durations),
    p90DurationMs: percentile(durations, 90),
    longest,
    totalApproved,
    totalRejected,
    approvalRate: totalDecided > 0 ? totalApproved / totalDecided : null,
    reviewers,
    recent,
    capped: opts?.capped ?? false,
    rework: null,
  };
}

// ---- numeric helpers (pure) ----
export function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

// "2d 4h" / "3h 12m" / "45m" / "30s" — compact, never decimals.
export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const clamped = ms < 0 ? 0 : ms;
  const sec = Math.round(clamped / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

export type StatsWindow = 30 | 90 | 365 | "all";

// DB query + mapping. Every decided output (JobAsset) within the window,
// newest decision first, capped. Rework counts are current totals.
export async function getReviewStats(opts: {
  days: StatsWindow;
  recentLimit?: number;
}): Promise<ReviewStats> {
  const TAKE = 1000;
  const since = opts.days === "all" ? null : new Date(Date.now() - opts.days * 86_400_000);

  const { db } = await import("@/lib/db");

  const [rows, openTickets, reopened] = await Promise.all([
    db.jobAsset.findMany({
      where: {
        reviewStatus: { in: ["APPROVED", "REJECTED"] },
        reviewedAt: since ? { gte: since } : { not: null },
        job: { status: { not: "FAILED" } },
      },
      select: {
        docType: true,
        displayName: true,
        variantKey: true,
        reviewStatus: true,
        createdAt: true,
        reviewedAt: true,
        reviewedById: true,
        reviewedBy: { select: { email: true, name: true } },
        job: {
          select: {
            styleId: true,
            style: { select: { name: true, customer: { select: { name: true } } } },
          },
        },
      },
      orderBy: { reviewedAt: "desc" },
      take: TAKE + 1,
    }),
    db.rejectionTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS", "FIXED"] } } }),
    db.rejectionTicket.count({ where: { reopenedCount: { gt: 0 } } }),
  ]);

  const capped = rows.length > TAKE;
  const outputs: StatsOutputInput[] = rows
    .slice(0, TAKE)
    .filter((r) => r.reviewedAt != null)
    .map((r) => ({
      styleId: r.job.styleId,
      styleName: r.job.style.name,
      customerName: r.job.style.customer.name,
      outputName: r.displayName ?? r.variantKey ?? r.docType,
      reviewStatus: r.reviewStatus as "APPROVED" | "REJECTED",
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt as Date,
      reviewerId: r.reviewedById,
      reviewerEmail: r.reviewedBy?.email ?? null,
      reviewerName: r.reviewedBy?.name ?? null,
    }));

  const stats = computeReviewStats(outputs, { recentLimit: opts.recentLimit ?? 25, capped });
  stats.rework = { openTickets, reopened };
  return stats;
}
