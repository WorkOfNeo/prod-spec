import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { triggerLabel } from "@/lib/queue/trigger-labels";

// History tab — the automation trace for ONE style, stitched from the rows
// every stage already writes: sync stamps → PO/EAN resolution → generation
// jobs (with why they fired) → review decisions → supplier-send queue →
// digest emails. Pure read; self-fetching so the (already heavy) style page
// only pays for it when the tab is open.

type Tone = "ok" | "info" | "warn" | "error";

type TimelineEvent = {
  at: Date;
  // A person's call (approve / reject) vs. something the pipeline did.
  kind?: "decision" | "automation";
  title: string;
  detail?: string | null;
  href?: string | null;
  tone: Tone;
};

const DOT: Record<Tone, string> = {
  ok: "bg-good",
  info: "bg-faint",
  warn: "bg-warn",
  error: "bg-bad",
};

export type HistoryFilter = "all" | "decisions" | "automation";

export async function HistoryTab({ styleId, filter = "all" }: { styleId: string; filter?: HistoryFilter }) {
  const [style, jobs, reviewActions, queueItems, emails] = await Promise.all([
    db.style.findUnique({
      where: { id: styleId },
      select: {
        createdAt: true,
        poNumber: true,
        eanQueuedAt: true,
        eanResolvedAt: true,
        eanStatus: true,
        eanAttempts: true,
        poFileName: true,
        cartonEan: true,
        supplierFolderUrl: true,
        _count: { select: { eans: true } },
      },
    }),
    db.job.findMany({
      where: { styleId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        finishedAt: true,
        status: true,
        triggerSource: true,
        error: true,
        _count: { select: { assets: true } },
      },
    }),
    db.reviewAction.findMany({
      where: { job: { styleId } },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        action: true,
        reason: true,
        user: { select: { email: true } },
      },
    }),
    db.supplierSendQueueItem.findMany({ where: { styleId }, orderBy: { queuedAt: "asc" } }),
    db.emailLog.findMany({
      where: { styleId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, type: true, status: true, to: true, subject: true },
    }),
  ]);

  if (!style) return null;

  const events: TimelineEvent[] = [];

  events.push({
    at: style.createdAt,
    title: "Style first synced from Monday",
    tone: "info",
  });

  if (style.eanQueuedAt) {
    events.push({
      at: style.eanQueuedAt,
      title: `PO landed${style.poNumber ? ` (${style.poNumber})` : ""} — queued for barcode scrape`,
      tone: "info",
    });
  }

  if (style.eanResolvedAt) {
    const resolved =
      style.eanStatus === "RESOLVED" ||
      style.eanStatus === "PARTIAL" ||
      style.eanStatus === "RESOLVED_FROM_MONDAY";
    events.push({
      at: style.eanResolvedAt,
      title: resolved
        ? `Barcodes ${style.eanStatus === "PARTIAL" ? "partially " : ""}resolved${
            style.eanStatus === "RESOLVED_FROM_MONDAY" ? " from Monday" : ""
          } — ${style._count.eans} size(s)${style.cartonEan ? " + carton EAN" : ""}`
        : `Barcode scrape last attempt: ${style.eanStatus.toLowerCase().replace(/_/g, " ")} (${style.eanAttempts} attempt(s))`,
      detail: style.poFileName ? `from ${style.poFileName}` : null,
      href: "/po-eans",
      tone: resolved ? "ok" : "warn",
    });
  }

  for (const j of jobs) {
    events.push({
      at: j.createdAt,
      title: `Generation job enqueued — ${triggerLabel(j.triggerSource)}`,
      tone: "info",
    });
    if (j.finishedAt) {
      events.push({
        at: j.finishedAt,
        title:
          j.status === "FAILED"
            ? "Generation failed"
            : `Rendered ${j._count.assets} document(s)${j.status === "AWAITING_REVIEW" ? " — awaiting review" : ""}`,
        detail: j.error,
        tone: j.status === "FAILED" ? "error" : "ok",
      });
    }
  }

  for (const a of reviewActions) {
    events.push({
      at: a.createdAt,
      kind: "decision",
      title: `Output ${a.action === "APPROVED" ? "approved" : "rejected"} by ${a.user.email}`,
      detail: a.reason,
      tone: a.action === "APPROVED" ? "ok" : "warn",
    });
  }

  for (const q of queueItems) {
    const label = q.displayName ?? q.docType;
    events.push({
      at: q.queuedAt,
      title: `Queued for supplier send — ${label}`,
      tone: "info",
    });
    if (q.lastPushAt) {
      events.push({
        at: q.lastPushAt,
        title:
          q.sharePointStatus === "UPLOADED"
            ? `Uploaded to supplier folder — ${label}`
            : q.sharePointStatus === "FAILED"
              ? `Supplier-folder upload failed — ${label} (${q.pushAttempts} attempt(s))`
              : `Supplier-folder upload skipped — ${label}`,
        href: q.sharePointUrl ?? style.supplierFolderUrl,
        tone:
          q.sharePointStatus === "UPLOADED"
            ? "ok"
            : q.sharePointStatus === "FAILED"
              ? "error"
              : "warn",
      });
    }
    if (q.sentAt) {
      events.push({
        at: q.sentAt,
        title: `Sent in supplier digest — ${label}`,
        tone: "ok",
      });
    }
  }

  for (const e of emails) {
    events.push({
      at: e.createdAt,
      title: `${e.type.toLowerCase().replace(/_/g, " ")} email ${e.status.toLowerCase()}`,
      detail: `to ${e.to || "—"} · ${e.subject}`,
      tone: e.status === "FAILED" ? "error" : e.status === "SENT" ? "ok" : "info",
    });
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  const shown = events.filter((e) =>
    filter === "all" ? true : filter === "decisions" ? e.kind === "decision" : e.kind !== "decision",
  );
  const filters: Array<[HistoryFilter, string]> = [
    ["all", "All"],
    ["decisions", "Decisions"],
    ["automation", "Automation"],
  ];

  return (
    <section data-section="History" className="border-line bg-surface overflow-hidden rounded-xl border">
      <div className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-ink text-[14px] font-semibold">History</h2>
          <p className="text-muted text-[12px]">Sync, PO and EANs, runs, decisions, supplier uploads and digests, newest first</p>
        </div>
        <nav aria-label="Show" className="bg-seg inline-flex rounded-lg p-0.5">
          {filters.map(([key, label]) => (
            <Link
              key={key}
              href={`/styles/${styleId}?tab=history${key === "all" ? "" : `&hist=${key}`}`}
              scroll={false}
              aria-current={filter === key ? "page" : undefined}
              className={`inline-flex h-7 items-center rounded-md px-2.5 text-[12px] transition-colors duration-150 ${
                filter === key ? "bg-seg-on text-seg-on-ink font-medium shadow-[var(--shadow-pop)]" : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted px-4 py-8 text-center text-[13px]">Nothing recorded here yet.</p>
      ) : (
        <ol data-private className="flex flex-col px-4 py-3">
          {shown.map((e, i) => (
            <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
              {/* The rail: a dot per event, a line to the next. */}
              <span aria-hidden="true" className="relative flex w-3 shrink-0 justify-center">
                <span className={`relative z-10 mt-1.5 size-2.5 rounded-full ring-4 ring-[var(--surface)] ${DOT[e.tone]}`} />
                {i < shown.length - 1 ? <span className="bg-line absolute top-3 bottom-[-0.5rem] w-px" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-ink text-[13px] font-medium">
                  {e.href ? (
                    <Link href={e.href} className="hover:underline" target={e.href.startsWith("http") ? "_blank" : undefined}>
                      {e.title}
                    </Link>
                  ) : (
                    e.title
                  )}
                </div>
                {e.detail ? <div className="text-muted mt-0.5 text-[12px]">{e.detail}</div> : null}
                <div className="text-faint mt-0.5 text-[11px] tabular-nums">{formatDate(e.at)}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
