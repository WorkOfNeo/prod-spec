import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";

// History tab — the automation trace for ONE style, stitched from the rows
// every stage already writes: sync stamps → PO/EAN resolution → generation
// jobs (with why they fired) → review decisions → supplier-send queue →
// digest emails. Pure read; self-fetching so the (already heavy) style page
// only pays for it when the tab is open.

type Tone = "ok" | "info" | "warn" | "error";

type TimelineEvent = {
  at: Date;
  title: string;
  detail?: string | null;
  href?: string | null;
  tone: Tone;
};

const TRIGGER_LABELS: Record<string, string> = {
  WEBHOOK: "Monday webhook (fields landed)",
  MANUAL_RERUN: "manual re-run",
  ADMIN_TEST: "admin test",
  MANUAL_IMPORT: "import promotion",
  TICKET_RERUN: "rejection-ticket re-run",
  TICKET_FIX: "rejection-ticket fix",
  EAN_RESOLVED: "barcodes landed (EAN handoff)",
  CRON_SWEEP: "backlog sweep",
  MANUAL_BULK: "bulk run",
};

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  info: "bg-zinc-300",
  warn: "bg-amber-400",
  error: "bg-red-500",
};

export async function HistoryTab({ styleId }: { styleId: string }) {
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
    const resolved = style.eanStatus === "RESOLVED" || style.eanStatus === "PARTIAL";
    events.push({
      at: style.eanResolvedAt,
      title: resolved
        ? `Barcodes ${style.eanStatus === "PARTIAL" ? "partially " : ""}resolved — ${style._count.eans} size(s)${style.cartonEan ? " + carton EAN" : ""}`
        : `Barcode scrape last attempt: ${style.eanStatus.toLowerCase().replace(/_/g, " ")} (${style.eanAttempts} attempt(s))`,
      detail: style.poFileName ? `from ${style.poFileName}` : null,
      href: "/po-eans",
      tone: resolved ? "ok" : "warn",
    });
  }

  for (const j of jobs) {
    events.push({
      at: j.createdAt,
      title: `Generation job enqueued — ${TRIGGER_LABELS[j.triggerSource] ?? j.triggerSource.toLowerCase()}`,
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

  return (
    <div className="mt-6 max-w-3xl">
      {events.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing recorded for this style yet.</p>
      ) : (
        <ol className="relative border-l border-zinc-200 pl-6">
          {events.map((e, i) => (
            <li key={i} className="relative pb-5">
              <span
                className={`absolute -left-[1.85rem] top-1.5 h-3 w-3 rounded-full border-2 border-white ${DOT[e.tone]}`}
              />
              <div className="text-xs tabular-nums text-zinc-400">{formatDate(e.at)}</div>
              <div className="text-sm font-medium text-zinc-800">
                {e.href ? (
                  <Link href={e.href} className="hover:underline" target={e.href.startsWith("http") ? "_blank" : undefined}>
                    {e.title}
                  </Link>
                ) : (
                  e.title
                )}
              </div>
              {e.detail ? <div className="mt-0.5 text-xs text-zinc-500">{e.detail}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
