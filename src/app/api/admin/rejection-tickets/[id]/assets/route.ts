import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";

export const runtime = "nodejs";

// Mirror the rejection-log page stamp so lazily-loaded labels match the
// server-rendered ones exactly.
const STAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const ASSET_SELECT = {
  jobId: true,
  variantKey: true,
  docType: true,
  placeholderCount: true,
  reviewStatus: true,
  createdAt: true,
  job: { select: { status: true } },
} as const;

type AssetRow = {
  jobId: string;
  variantKey: string | null;
  docType: string;
  placeholderCount: number;
  reviewStatus: string;
  createdAt: Date;
  job: { status: string };
};

function toView(asset: AssetRow | null) {
  if (!asset) return null;
  return {
    jobId: asset.jobId,
    previewQuery: asset.variantKey
      ? `variantKey=${encodeURIComponent(asset.variantKey)}`
      : `docType=${asset.docType}`,
    placeholderCount: asset.placeholderCount,
    reviewStatus: asset.reviewStatus,
    jobStatus: asset.job.status,
    generatedAtLabel: STAMP_FORMAT.format(asset.createdAt),
  };
}

// The two PDFs a rejection ticket may want to show, fetched on expand:
//   • rejected — the exact asset the ticket was raised against (ticket.jobId +
//     its variantKey). JobAsset.pdf keeps the rendered bytes, and re-runs spawn
//     NEW jobs (the runner only deletes the running job's own assets), so the
//     originally-rejected PDF survives. null if that job/asset is truly gone.
//   • latest — the newest asset for the same output across the style, i.e. what
//     it looks like now after edits / silent re-runs.
// The log leads with `rejected` (what the reviewer commented on) and only
// surfaces `latest` separately when it's a different job (a re-run happened).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const ticket = await db.rejectionTicket.findUnique({
    where: { id },
    select: { styleId: true, jobId: true, variantKey: true, docType: true },
  });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // A real variantKey identifies the exact output; a legacy ticket without one
  // falls back to its docType.
  const outputMatch = ticket.variantKey
    ? { variantKey: ticket.variantKey }
    : { docType: ticket.docType };

  const [rejected, latest] = await Promise.all([
    ticket.jobId
      ? db.jobAsset.findFirst({
          where: { jobId: ticket.jobId, ...outputMatch },
          select: ASSET_SELECT,
        })
      : Promise.resolve(null),
    db.jobAsset.findFirst({
      where: { job: { styleId: ticket.styleId }, ...outputMatch },
      orderBy: { createdAt: "desc" },
      select: ASSET_SELECT,
    }),
  ]);

  return NextResponse.json({ rejected: toView(rejected), latest: toView(latest) });
}
