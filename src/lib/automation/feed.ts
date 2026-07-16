import { db } from "@/lib/db";

// =====================================================
// Unified automation activity feed — one chronological stream over every
// durable run record the pipeline already writes, so /automation can answer
// "what ran, and did it work?" without hopping between five surfaces:
//
//   CronRun            po-eans / jobs / supplier-upload ticks
//   SyncJob            Monday syncs (customers, suppliers, styles, …)
//   SupplierSendBatch  midnight / manual digest batches
//   BulkRunBatch       /styles bulk generation runs
//   EmailLog           every email that left (or failed / was simulated)
//
// Read-side only: nothing here writes. The event-driven moments that
// deliberately don't record runs (webhook enqueues, approve-time pushes) are
// visible through the Job rows / queue stamps they create — surfaced on the
// per-style History tab, not as feed rows.
// =====================================================

export type FeedKind = "sync" | "ean" | "generation" | "bulk" | "upload" | "digest" | "email";

export type FeedStatus =
  | "ok"
  | "partial"
  | "failed"
  | "skipped"
  | "dry-run"
  | "running"
  | "idle";

export type FeedEvent = {
  id: string;
  at: Date;
  kind: FeedKind;
  title: string;
  // "cron" | "operator" | "midnight" | "manual" | "system"
  source: string;
  status: FeedStatus;
  detail: string;
  href: string | null;
  durationMs: number | null;
  // False for no-op cron ticks — the default view hides those.
  hadActivity: boolean;
};

export const FEED_KIND_LABELS: Record<FeedKind, string> = {
  sync: "Monday sync",
  ean: "EAN scrape",
  generation: "Generation",
  bulk: "Bulk run",
  upload: "SharePoint upload",
  digest: "Supplier digest",
  email: "Email",
};

const CRON_KIND: Record<string, { kind: FeedKind; title: string }> = {
  "po-eans": { kind: "ean", title: "EAN scrape" },
  jobs: { kind: "generation", title: "Generation run" },
  "supplier-upload": { kind: "upload", title: "SharePoint upload sweep" },
};

export async function getAutomationFeed(opts?: {
  limit?: number;
  kinds?: FeedKind[];
  includeIdle?: boolean;
}): Promise<{ events: FeedEvent[]; hiddenIdle: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 300);
  const kinds = opts?.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
  const wants = (k: FeedKind) => kinds === null || kinds.has(k);

  // When the view is filtered to specific kinds, filter the CronRun fetch in
  // SQL too. cron_runs mixes three kinds ticking every few minutes, so the
  // newest `limit` rows overall span only a few hours — filtering after the
  // fetch made a kind-scoped view (e.g. "SharePoint upload") show nothing
  // whenever that kind's last real activity was older than the mixed window.
  const wantedCronKinds = Object.keys(CRON_KIND).filter((k) => wants(CRON_KIND[k].kind));

  const [cronRuns, syncJobs, batches, bulkRuns, emails] = await Promise.all([
    wantedCronKinds.length > 0
      ? db.cronRun.findMany({
          where: kinds === null ? undefined : { kind: { in: wantedCronKinds } },
          orderBy: { createdAt: "desc" },
          take: limit,
        })
      : [],
    wants("sync") ? db.syncJob.findMany({ orderBy: { startedAt: "desc" }, take: limit }) : [],
    wants("digest")
      ? db.supplierSendBatch.findMany({ orderBy: { createdAt: "desc" }, take: limit })
      : [],
    wants("bulk") ? db.bulkRunBatch.findMany({ orderBy: { createdAt: "desc" }, take: limit }) : [],
    wants("email") ? db.emailLog.findMany({ orderBy: { createdAt: "desc" }, take: limit }) : [],
  ]);

  const events: FeedEvent[] = [];

  for (const r of cronRuns) {
    const meta = CRON_KIND[r.kind];
    if (!meta || !wants(meta.kind)) continue;
    // Event-driven runs (approve-time / runner / publish pushes record with
    // their own source; see pushQueuedSupplierUploads recordRunAs) only exist
    // because something was attempted — never bucket them as idle, even when
    // the outcome was all flags (e.g. "no PO folder") rather than uploads.
    const eventDriven = r.source !== "secret" && r.source !== "session";
    const hadActivity =
      r.processed > 0 || r.failed > 0 || r.requeued > 0 || r.enqueued > 0 || eventDriven;
    const detail =
      r.kind === "po-eans"
        ? `resolved ${r.processed} · requeued ${r.requeued} · failed ${r.failed}`
        : r.kind === "jobs"
          ? `enqueued ${r.enqueued} · rendered ${r.processed} · failed ${r.failed}`
          : `uploaded ${r.processed} · failed ${r.failed} · backfilled ${r.enqueued}` +
            (r.requeued > 0 ? ` · re-armed ${r.requeued}` : "");
    events.push({
      id: `cron:${r.id}`,
      at: r.createdAt,
      kind: meta.kind,
      title: meta.title,
      source: r.source === "secret" ? "cron" : r.source === "session" ? "operator" : r.source,
      status: r.skipped
        ? "skipped"
        : r.failed > 0
          ? r.processed > 0
            ? "partial"
            : "failed"
          : hadActivity
            ? "ok"
            : "idle",
      detail: r.skipped && r.note ? `${detail} — ${r.note}` : r.note ? `${detail} — ${r.note}` : detail,
      href:
        meta.kind === "ean" ? "/po-eans" : meta.kind === "upload" ? "/settings/approved" : null,
      durationMs: r.durationMs,
      hadActivity,
    });
  }

  for (const s of syncJobs) {
    events.push({
      id: `sync:${s.id}`,
      at: s.startedAt,
      kind: "sync",
      title: `Monday sync — ${s.kind.toLowerCase().replace(/_/g, " ")}`,
      source: "system",
      status: s.status === "RUNNING" ? "running" : s.status === "FAILED" ? "failed" : "ok",
      detail:
        `${s.itemsSynced}/${s.itemsTotal} synced · ${s.itemsFailed} failed · ${s.itemsSkipped} skipped` +
        (s.error ? ` — ${s.error}` : ""),
      href: "/sync",
      durationMs:
        s.finishedAt != null ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
      hadActivity: s.itemsTotal > 0 || s.itemsFailed > 0 || s.error != null,
    });
  }

  for (const b of batches) {
    events.push({
      id: `digest:${b.id}`,
      at: b.createdAt,
      kind: "digest",
      title: "Supplier digest batch",
      source: b.source,
      status:
        b.status === "DRY_RUN"
          ? "dry-run"
          : b.status === "EMPTY"
            ? "idle"
            : b.status === "SENT"
              ? "ok"
              : b.status === "PARTIAL"
                ? "partial"
                : "failed",
      detail: `${b.sentCount}/${b.outputCount} outputs sent · ${b.supplierCount} supplier(s)`,
      href: "/settings/approved",
      durationMs:
        b.finishedAt != null ? b.finishedAt.getTime() - b.createdAt.getTime() : null,
      hadActivity: b.outputCount > 0,
    });
  }

  for (const b of bulkRuns) {
    events.push({
      id: `bulk:${b.id}`,
      at: b.createdAt,
      kind: "bulk",
      title: `Bulk run — ${b.label}`,
      source: b.createdByEmail ?? "operator",
      status: b.finishedAt == null ? "running" : "ok",
      detail: `${b.total} job(s) enqueued`,
      href: "/styles",
      durationMs:
        b.finishedAt != null ? b.finishedAt.getTime() - b.createdAt.getTime() : null,
      hadActivity: true,
    });
  }

  for (const e of emails) {
    events.push({
      id: `email:${e.id}`,
      at: e.createdAt,
      kind: "email",
      title: `Email — ${e.type.toLowerCase().replace(/_/g, " ")}`,
      source: "system",
      status:
        e.status === "SENT"
          ? "ok"
          : e.status === "SIMULATED"
            ? "dry-run"
            : e.status === "SKIPPED"
              ? "skipped"
              : "failed",
      detail: `to ${e.to || "—"} · ${e.subject}`,
      href: e.styleId ? `/styles/${e.styleId}` : null,
      durationMs: null,
      // Simulated/skipped emails (RESEND off) fire per approval and would
      // drown the feed — real sends and failures are the activity.
      hadActivity: e.status === "SENT" || e.status === "FAILED",
    });
  }

  const sorted = events.sort((a, b) => b.at.getTime() - a.at.getTime());
  const withIdle = sorted.slice(0, limit + 200); // keep the hidden-count honest around the cut
  const visible = opts?.includeIdle
    ? withIdle
    : withIdle.filter((e) => e.hadActivity || e.status === "running");
  const hiddenIdle = withIdle.length - visible.length;
  return { events: visible.slice(0, limit), hiddenIdle };
}
