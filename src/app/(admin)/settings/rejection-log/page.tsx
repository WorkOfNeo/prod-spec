import { db } from "@/lib/db";
import { TicketList, type TicketRow, type StyleOutputView } from "./ticket-list";
import { requireAdminPage } from "@/lib/auth-server";
import { outputEditLink } from "@/lib/outputs/output-edit-link";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { styleOutputBases, notGeneratedReason } from "@/lib/rejection-log/style-outputs";
import { baseVariantKey } from "@/lib/tickets/orphan";

export const dynamic = "force-dynamic";

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });
const STAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// "generated 12 min ago" — the at-a-glance freshness signal the operator wants
// after a Prod Spec rerun. The page is force-dynamic so this recomputes every
// load; anything older than a day falls back to the absolute stamp.
function relativeStamp(d: Date, now: Date): string {
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return STAMP_FORMAT.format(d);
}

// Safety bound on the backlog we render at once. The list groups by style, so
// even a few thousand tickets collapse to a handful of rows — and with each
// ticket's latest asset now loaded lazily on expand, the page is a single
// cheap query. If the open backlog ever exceeds this, the UI says so instead
// of silently hiding rows (the old hard 200 cap did).
const MAX_TICKETS = 2000;

// Rejection log — the admin workbench for outputs the reviewer rejected.
// Tickets carry snapshots (the runner deletes assets on every re-run); each
// rejected + latest generated assets are fetched on demand when expanded (see
// the /assets route) rather than enriched up front.
// Two views over the same backlog, split by where the admin's work stands:
//   • Active  = OPEN + IN_PROGRESS — rejections still needing work (the workbench).
//   • History = FIXED + RESOLVED — marked fixed (now the reviewer's to re-review)
//     or approved. A re-rejection flips a FIXED ticket back to OPEN, so it
//     returns to Active on its own. Queried per view so the cap can't let
//     resolved threads crowd out the open ones.
const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS"] as const;
const HISTORY_STATUSES = ["FIXED", "RESOLVED"] as const;

export const metadata = { title: "Rejection log" };

export default async function RejectionLogPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireAdminPage();

  const view = (await searchParams).view === "history" ? "history" : "active";
  const statuses = view === "history" ? HISTORY_STATUSES : ACTIVE_STATUSES;

  const [tickets, totalCount, activeCount, historyCount] = await Promise.all([
    db.rejectionTicket.findMany({
      where: { status: { in: [...statuses] } },
      orderBy: { createdAt: "desc" },
      take: MAX_TICKETS,
      include: { reportedBy: { select: { name: true, email: true } } },
    }),
    db.rejectionTicket.count({ where: { status: { in: [...statuses] } } }),
    db.rejectionTicket.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
    db.rejectionTicket.count({ where: { status: { in: [...HISTORY_STATUSES] } } }),
  ]);
  const isHistory = view === "history";

  // Resolve each involved style's applied Prod Spec so cover / general-info
  // tickets can deep-link to the right editor tab (layout outputs don't need
  // it). All tickets of a style share one spec.
  const styleIds = [...new Set(tickets.map((t) => t.styleId))];
  const styles =
    styleIds.length === 0
      ? []
      : await db.style.findMany({
          where: { id: { in: styleIds } },
          select: { id: true, prodSpec: { select: { id: true } } },
        });
  const prodSpecByStyle = new Map(styles.map((s) => [s.id, s.prodSpec?.id ?? null]));

  // "Re-generated since rejected" signal: the newest non-FAILED asset per
  // (style × variantKey). A ticket is flagged when that asset is newer than the
  // rejection — which also catches regenerations that never went through "Mark
  // fixed" (auto-runs, full re-runs), the overview a superadmin wants. Lightweight
  // (no PDF bytes); newest-first so the first hit per key is the latest.
  const latestAssets =
    styleIds.length === 0
      ? []
      : await db.jobAsset.findMany({
          where: { job: { styleId: { in: styleIds }, status: { not: "FAILED" } } },
          orderBy: { createdAt: "desc" },
          select: { variantKey: true, createdAt: true, job: { select: { styleId: true } } },
        });
  const latestAssetAt = new Map<string, Date>();
  for (const a of latestAssets) {
    const key = `${a.job.styleId}|${a.variantKey ?? ""}`;
    if (!latestAssetAt.has(key)) latestAssetAt.set(key, a.createdAt);
  }

  // Comment attachments (images the reviewer added). Metadata only — never the
  // bytes; each <img> in the log streams those from the serve route on demand.
  // Guarded: the rejection_attachments table may not exist yet in the window
  // before db:deploy runs, so a missing table degrades to "no attachments"
  // rather than 500-ing the whole log.
  const attachmentsByTicket = new Map<string, { id: string; fileName: string; mimeType: string }[]>();
  if (tickets.length > 0) {
    try {
      const atts = await db.rejectionAttachment.findMany({
        where: { ticketId: { in: tickets.map((t) => t.id) } },
        orderBy: { createdAt: "asc" },
        select: { id: true, ticketId: true, fileName: true, mimeType: true },
      });
      for (const a of atts) {
        const list = attachmentsByTicket.get(a.ticketId) ?? [];
        list.push({ id: a.id, fileName: a.fileName, mimeType: a.mimeType });
        attachmentsByTicket.set(a.ticketId, list);
      }
    } catch {
      // rejection_attachments not deployed yet — render the log without images.
    }
  }

  // Per-style current output set (one styleOutputBases read per style; the
  // backlog groups to a handful of styles). Reused below for the at-a-glance
  // overview, and here to tell whether a ticket's output is still in the spec.
  const FRAMING_KEYS = new Set(["__cover__", "__general_info__"]);
  const basesByStyle = new Map<string, Awaited<ReturnType<typeof styleOutputBases>>>();
  await Promise.all(
    styleIds.map(async (sid) => {
      basesByStyle.set(sid, await styleOutputBases(sid));
    }),
  );
  // A RESOLVED ticket was APPROVED by the reviewer (vs auto-resolved when its
  // output was removed) iff its output base is still declared in the current
  // spec — the only two resolution paths are reviewer-approval and removed-
  // output cleanup. This survives re-runs (which delete/recreate assets and so
  // wipe the per-asset approval history) where "latest asset approved" cannot.
  const declaredBasesByStyle = new Map<string, Set<string>>();
  for (const [sid, bases] of basesByStyle) {
    declaredBasesByStyle.set(sid, new Set(bases.filter((o) => o.declared).map((o) => o.variantKey)));
  }
  const isOutputLive = (styleId: string, variantKey: string) => {
    const base = baseVariantKey(variantKey);
    return FRAMING_KEYS.has(base) || (declaredBasesByStyle.get(styleId)?.has(base) ?? false);
  };

  const rows: TicketRow[] = tickets.map((t) => {
    const edit = outputEditLink(t.variantKey, prodSpecByStyle.get(t.styleId) ?? null);
    const prodSpecId = prodSpecByStyle.get(t.styleId) ?? null;
    const regenAt = latestAssetAt.get(`${t.styleId}|${t.variantKey}`);
    const regeneratedAfterRejection = !!regenAt && regenAt > t.createdAt;
    const approved = t.status === "RESOLVED" && isOutputLive(t.styleId, t.variantKey);
    // If this ticket's output can't currently be generated — excluded by a
    // doc-type rule, or missing required Monday fields — surface the SAME
    // reason the review screens show, so the admin knows re-running won't help.
    const outputBase = (basesByStyle.get(t.styleId) ?? []).find(
      (o) => o.variantKey === baseVariantKey(t.variantKey),
    );
    const notGeneratedText = outputBase ? notGeneratedReason(outputBase) : null;
    return {
      id: t.id,
      status: t.status,
      styleId: t.styleId,
      styleName: t.styleName,
      styleNumber: t.styleNumber,
      outputName: t.outputName,
      docType: t.docType,
      variantKey: t.variantKey,
      // Which AI-fix flow (if any) this output supports: an Output Builder
      // layout (edit the definition), the General information page (edit the
      // markdown), or none (cover / coded outputs — no editable source).
      aiFixKind: layoutIdFromVariantKey(t.variantKey)
        ? "layout"
        : baseVariantKey(t.variantKey) === "__general_info__"
          ? "general-info"
          : null,
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
      editHref: edit?.href ?? null,
      editLabel: edit?.label ?? "",
      // Open the style's applied Prod Spec from the group header (new tab).
      prodSpecHref: prodSpecId ? `/prod-specs/${prodSpecId}` : null,
      regeneratedAfterRejection,
      regeneratedAtLabel: regeneratedAfterRejection && regenAt ? STAMP_FORMAT.format(regenAt) : null,
      approved,
      notGeneratedText,
      attachments: (attachmentsByTicket.get(t.id) ?? []).map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mimeType: a.mimeType,
        url: `/api/admin/rejection-tickets/${t.id}/attachments/${a.id}`,
      })),
      searchBlob:
        `${t.styleName} ${t.styleNumber} ${t.outputName} ${t.customerName} ${t.businessArea ?? ""} ${t.poNumber ?? ""} ${t.comment}`.toLowerCase(),
    };
  });

  // Newest open (OPEN/IN_PROGRESS) rejection per (style, output base) — the
  // reference point for "has this output been regenerated since it was
  // rejected?", plus the ticket's clean output name (used when an orphaned
  // output's base no longer resolves to a registered variant).
  const openRejection = new Map<string, Map<string, { at: Date; name: string }>>();
  for (const t of tickets) {
    if (t.status !== "OPEN" && t.status !== "IN_PROGRESS") continue;
    const byBase = openRejection.get(t.styleId) ?? new Map();
    const b = baseVariantKey(t.variantKey);
    const prev = byBase.get(b);
    if (!prev || t.createdAt > prev.at) byBase.set(b, { at: t.createdAt, name: t.outputName });
    openRejection.set(t.styleId, byBase);
  }

  // Per-style output set + freshness, for the at-a-glance overview and the
  // style-level regenerate / mark-fixed actions. One styleOutputBases read per
  // style in the log (force-dynamic admin page; the backlog groups to a handful
  // of styles). We show the CURRENT spec outputs + bundle framing + anything
  // with an open rejection — never outputs that were swapped out and merely
  // still carry old assets (those would clutter the list with stale rows).
  const order = (o: { variantKey: string; declared: boolean }) =>
    o.variantKey === "__cover__" ? 0 : o.variantKey === "__general_info__" ? 1 : o.declared ? 2 : 3;
  const now = new Date();
  const styleOutputs: Record<string, StyleOutputView[]> = {};
  for (const sid of styleIds) {
    const bases = basesByStyle.get(sid) ?? [];
    const rejected = openRejection.get(sid) ?? new Map();
    styleOutputs[sid] = bases
      .filter((o) => o.declared || FRAMING_KEYS.has(o.variantKey) || rejected.has(o.variantKey))
      .map((o) => {
        const rej = rejected.get(o.variantKey) ?? null;
        return {
          variantKey: o.variantKey,
          // Orphaned outputs (removed from the spec, no registered variant)
          // fall back to the rejection ticket's human name.
          name: !o.declared && rej ? rej.name : o.name,
          declared: o.declared,
          ready: o.ready,
          missing: o.missing,
          excluded: o.excluded,
          exclusionReason: o.exclusionReason,
          lastGeneratedLabel: o.lastGeneratedAt ? relativeStamp(o.lastGeneratedAt, now) : null,
          rejected: rej !== null,
          regeneratedSinceRejection: !!(rej && o.lastGeneratedAt && o.lastGeneratedAt > rej.at),
          reviewStatus: o.latestReviewStatus,
        };
      })
      .sort((a, b) => order(a) - order(b));
  }

  // Tabs: Active is the workbench (default); History is the read-only record of
  // fixed/resolved threads. Plain links (?view=) keep this a server component.
  const tabs = [
    { key: "active", label: "Active", count: activeCount, href: "/settings/rejection-log" },
    { key: "history", label: "History", count: historyCount, href: "/settings/rejection-log?view=history" },
  ] as const;

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Rejection log</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        {isHistory ? (
          <>
            Rejections that have been <strong>marked fixed</strong> (now awaiting the reviewer&apos;s
            re-review) or <strong>approved</strong>. A re-rejection sends a thread back to Active. This
            view is read-only — work open rejections on the Active tab.
          </>
        ) : (
          <>
            Outputs rejected by the reviewer, with their comments. Work them here:{" "}
            <strong>Re-run</strong> regenerates silently, <strong>Mark fixed &amp; notify</strong>{" "}
            re-runs and posts an in-app notification telling the reviewer to take another look.
            Approving the output on the review screen resolves its ticket automatically, moving it to
            History.
          </>
        )}
      </p>

      <div className="mt-4 flex gap-1 border-b border-zinc-200">
        {tabs.map((t) => {
          const active = t.key === view;
          return (
            <a
              key={t.key}
              href={t.href}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {t.label}{" "}
              <span className={`tabular-nums ${active ? "text-zinc-500" : "text-zinc-400"}`}>
                {t.count}
              </span>
            </a>
          );
        })}
      </div>

      {totalCount > rows.length ? (
        <p className="mt-2 text-xs text-amber-700">
          Showing the {rows.length.toLocaleString()} most recent of {totalCount.toLocaleString()}{" "}
          {isHistory ? "fixed / resolved threads" : "open rejections"} — resolve older threads to
          clear the backlog.
        </p>
      ) : null}

      <TicketList rows={rows} styleOutputs={isHistory ? {} : styleOutputs} view={view} />
    </div>
  );
}
