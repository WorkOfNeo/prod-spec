import { db } from "@/lib/db";
import { TicketList, type TicketRow } from "./ticket-list";

export const dynamic = "force-dynamic";

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });
const STAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// Rejection log — the admin workbench for outputs the reviewer rejected.
// Tickets carry snapshots (the runner deletes assets on every re-run), so
// the page enriches each ticket with the LATEST generated asset for its
// (style × variantKey) to show where the output stands now.
export default async function RejectionLogPage() {
  const tickets = await db.rejectionTicket.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { reportedBy: { select: { name: true, email: true } } },
  });

  // Latest asset per (styleId, variantKey) across the involved styles —
  // one query, newest first, first hit per key wins.
  const styleIds = [...new Set(tickets.map((t) => t.styleId))];
  const recentAssets =
    styleIds.length === 0
      ? []
      : await db.jobAsset.findMany({
          where: { job: { styleId: { in: styleIds } } },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: {
            id: true,
            jobId: true,
            variantKey: true,
            docType: true,
            placeholderCount: true,
            reviewStatus: true,
            createdAt: true,
            job: { select: { styleId: true, status: true } },
          },
        });
  const latestByKey = new Map<string, (typeof recentAssets)[number]>();
  for (const a of recentAssets) {
    const key = `${a.job.styleId}::${a.variantKey ?? `doc:${a.docType}`}`;
    if (!latestByKey.has(key)) latestByKey.set(key, a);
  }

  const rows: TicketRow[] = tickets.map((t) => {
    const latest =
      latestByKey.get(`${t.styleId}::${t.variantKey || `doc:${t.docType}`}`) ?? null;
    return {
      id: t.id,
      status: t.status,
      styleId: t.styleId,
      styleName: t.styleName,
      styleNumber: t.styleNumber,
      outputName: t.outputName,
      variantKey: t.variantKey,
      customerName: t.customerName,
      businessArea: t.businessArea,
      poNumber: t.poNumber,
      comment: t.comment,
      reportedBy: t.reportedBy.name || t.reportedBy.email,
      reopenedCount: t.reopenedCount,
      createdAtLabel: DAY_FORMAT.format(t.createdAt),
      historyLabel: [
        `Rejected ${STAMP_FORMAT.format(t.createdAt)} by ${t.reportedBy.name || t.reportedBy.email}`,
        t.startedAt ? `Start work ${STAMP_FORMAT.format(t.startedAt)}` : null,
        t.fixedAt ? `Marked fixed ${STAMP_FORMAT.format(t.fixedAt)}` : null,
        t.resolvedAt ? `Resolved ${STAMP_FORMAT.format(t.resolvedAt)}` : null,
        t.reopenedCount > 0 ? `Reopened ×${t.reopenedCount}` : null,
      ]
        .filter(Boolean)
        .join(" → "),
      latest: latest
        ? {
            jobId: latest.jobId,
            previewQuery: latest.variantKey
              ? `variantKey=${encodeURIComponent(latest.variantKey)}`
              : `docType=${latest.docType}`,
            placeholderCount: latest.placeholderCount,
            reviewStatus: latest.reviewStatus,
            jobStatus: latest.job.status,
            generatedAtLabel: STAMP_FORMAT.format(latest.createdAt),
          }
        : null,
      searchBlob:
        `${t.styleName} ${t.styleNumber} ${t.outputName} ${t.customerName} ${t.businessArea ?? ""} ${t.poNumber ?? ""} ${t.comment}`.toLowerCase(),
    };
  });

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Rejection log</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Outputs rejected by the reviewer, with their comments. Work them here: <strong>Re-run</strong>{" "}
        regenerates silently (no email), <strong>Mark fixed &amp; notify</strong> re-runs and tells the
        reviewer to take another look. Approving the output on the review screen resolves its ticket
        automatically.
      </p>
      <TicketList rows={rows} />
    </div>
  );
}
