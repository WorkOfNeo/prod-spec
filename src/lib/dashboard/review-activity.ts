import { db } from "@/lib/db";
import type { JobStatus } from "@/generated/prisma/enums";

// Super-admin review reporting (T2): every claimed review with its start
// (reviewClaimedAt) and end (reviewEndedAt) so an admin can see who reviewed
// what and how long it took. Read-only — the start is stamped by the claim
// flow (claim.ts) and the end by the approval track at the settle seam; this
// module never writes either.
//
// Resilient by design: reviewEndedAt may not be in the DB yet (the migration
// is additive and Niels runs db:deploy on his cadence). A select of a missing
// column throws, so we fall back to a start-only query and flag it — the same
// tolerance the dashboard applies to a not-yet-migrated table.

export type ReviewActivityRow = {
  jobId: string;
  styleId: string;
  styleName: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  reviewerName: string | null;
  status: JobStatus;
  startedAt: Date;
  endedAt: Date | null;
};

export type ReviewActivity = {
  rows: ReviewActivityRow[];
  // The reviewEndedAt column isn't deployed yet — every end stays blank and
  // the page shows a hint instead of implying the data is simply absent.
  endColumnMissing: boolean;
};

type JobRow = {
  id: string;
  styleId: string;
  status: JobStatus;
  reviewClaimedAt: Date | null;
  reviewClaimedBy: { name: string; email: string } | null;
  style: {
    name: string;
    poNumber: string | null;
    businessArea: string | null;
    customer: { name: string };
    businessAreaRef: { name: string } | null;
  };
};

const BASE_SELECT = {
  id: true,
  styleId: true,
  status: true,
  reviewClaimedAt: true,
  reviewClaimedBy: { select: { name: true, email: true } },
  style: {
    select: {
      name: true,
      poNumber: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
    },
  },
} as const;

function toRow(j: JobRow, endedAt: Date | null): ReviewActivityRow {
  return {
    jobId: j.id,
    styleId: j.styleId,
    styleName: j.style.name,
    customerName: j.style.customer.name,
    businessArea: j.style.businessAreaRef?.name ?? j.style.businessArea ?? null,
    poNumber: j.style.poNumber ?? null,
    reviewerName: j.reviewClaimedBy ? j.reviewClaimedBy.name || j.reviewClaimedBy.email : null,
    status: j.status,
    // Filtered to reviewClaimedAt != null below, so the start is always set.
    startedAt: j.reviewClaimedAt as Date,
    endedAt,
  };
}

export async function getReviewActivity(limit = 200): Promise<ReviewActivity> {
  // Only claimed reviews have a start→end span worth reporting.
  const where = { reviewClaimedAt: { not: null } } as const;
  const orderBy = { reviewClaimedAt: "desc" } as const;
  try {
    const jobs = await db.job.findMany({
      where,
      select: { ...BASE_SELECT, reviewEndedAt: true },
      orderBy,
      take: limit,
    });
    return { rows: jobs.map((j) => toRow(j, j.reviewEndedAt)), endColumnMissing: false };
  } catch {
    const jobs = await db.job.findMany({ where, select: BASE_SELECT, orderBy, take: limit });
    return { rows: jobs.map((j) => toRow(j, null)), endColumnMissing: true };
  }
}
