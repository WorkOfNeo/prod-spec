import { db } from "@/lib/db";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "./push-to-supplier";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getSupplierBatchSendEnabled, getSupplierSendMinPo } from "@/lib/settings/app-settings";
import { deliverablePoWhere } from "@/lib/publish/supplier-send-cutoff";

// =====================================================
// Queue-driven supplier-folder upload (WS2b's missing half). Walks the unsent
// supplier-send queue and pushes each style's approved PDFs into the supplier's
// OWN SharePoint folder (Supplier.sharepointUrl → "<PO> - <customer> -
// <supplier>" folder → "APPROVED LAYOUTS" subfolder, shared across styles on the
// same PO, via pushApprovedAssetsToSupplier), then stamps the queue rows'
// sharePointStatus — the previously write-only column /settings/approved shows.
//
// Called fail-soft from every approval path (job publish, per-asset approve,
// runner auto-approve) so files land in the supplier folder the moment an
// output is approved; by the RECURRING upload sweep (?uploadOnly=1 cron, WS3)
// so retries + backfilled rows drain during the day; and again by the midnight
// cron (includeFloated) so everything is in place before the digest email
// claims "files are in your SharePoint folder".
//
// Gated behind the same supplierBatchSendEnabled master flag as the batch
// send — the /settings/approved toggle promises "nothing is pushed and no
// email is sent" while OFF. The manual per-style push buttons bypass this lib
// entirely and keep working regardless.
//
// Status semantics per queue row:
//   UPLOADED — in the supplier folder (sharePointUrl set); not retried, but
//              unverified until WS4 lists the real folder and confirms every
//              document of the slot is present (re-arms to PENDING when not).
//   FAILED   — transient/permission error (e.g. write 403); retried until
//              pushAttempts hits MAX_PUSH_ATTEMPTS, then it "floats" for the
//              recurring sweep (surfaced on /settings/approved). The midnight
//              sweep passes includeFloated and still retries once nightly, so
//              a fixed permission self-heals within a day.
//   SKIPPED  — data-shaped gap (no supplier, no folder link, asset no longer
//              approved, customer delivers own). Also retried each sweep —
//              these fail fast before any Graph write — so fixing the data
//              (e.g. setting the Monday folder link) self-heals without anyone
//              re-triggering.
//
// A queue row is one output SLOT (base variantKey) holding a representative
// jobAssetId. A multi-document slot (carton X-of-Y) has several PDFs — the
// sweep re-expands each slot to ALL of its current approved documents via
// current-outputs, so the whole set lands in the folder, not just the
// representative.
// =====================================================

// Consecutive FAILED pushes before the recurring sweep stops retrying a row
// (mirrors MAX_EAN_ATTEMPTS / MAX_GEN_ATTEMPTS). The midnight sweep ignores
// the cap; a new approved render resets it (see enqueueApprovedAsset).
export const MAX_PUSH_ATTEMPTS = 3;

// The midnight digest stamps sentAt on every pending row once its email SENDS,
// whatever the row's sharePointStatus — so a row that was still FAILED /
// NO_FOLDER / SKIPPED at midnight would otherwise leave the sweep's sentAt-null
// pool and never reach the supplier folder at all. Sent rows therefore keep a
// bounded retry lease: they stay in the sweep while their queuedAt is recent.
// Keyed on queuedAt (NOT lastPushAt, which every retry refreshes — that would
// make the lease self-renewing and churn forever): re-arms (a new render, a
// verify heal) reset queuedAt and grant a fresh lease; a gap nobody fixes ages
// out of the sweep after a fortnight but stays visible on /settings/approved.
//
// Kept equal to verify's SENT_REVERIFY_WINDOW_MS on purpose: verify re-arms a
// row to PENDING when its file has gone missing, and only this sweep can act on
// that. A shorter lease here than there would let verify heal rows the push has
// already stopped looking at — they'd sit PENDING forever, worse than before.
export const SENT_RETRY_LEASE_MS = 14 * 24 * 60 * 60 * 1000;

export type SupplierUploadSweep = {
  styles: number;
  uploaded: number;
  failed: number;
  skipped: number;
  noFolder: number; // PO folder not found under the supplier (flagged, retried each sweep)
  ambiguous: number; // several folders match the PO — needs a human (flagged, retried)
  // Per-style failure detail so the cron JSON says WHY, not just "failed: 13".
  failures: Array<{ styleId: string; status: StampStatus; message: string }>;
};

const EMPTY_SWEEP: SupplierUploadSweep = {
  styles: 0,
  uploaded: 0,
  failed: 0,
  skipped: 0,
  noFolder: 0,
  ambiguous: 0,
  failures: [],
};

// Non-UPLOADED terminal statuses the sweep stamps. NO_FOLDER / AMBIGUOUS are new
// folder-shaped flags (PO folder absent / several match); all three non-FAILED
// take no strike so they retry every sweep until the gap is fixed.
type StampStatus = "FAILED" | "SKIPPED" | "NO_FOLDER" | "AMBIGUOUS";

export async function pushQueuedSupplierUploads(opts?: {
  styleIds?: string[];
  // Midnight retry sweep: also retry rows that already used up their
  // MAX_PUSH_ATTEMPTS strikes. The recurring day-time sweep leaves them
  // floated so a persistent 403 can't hammer Graph every tick.
  includeFloated?: boolean;
  // When set (and the sweep touched at least one style), persist this sweep as
  // a CronRun (kind "supplier-upload", source = this value) so event-driven
  // pushes — approve-time, job publish, runner auto-approve — show up in the
  // /automation activity feed. Without it those uploads happened invisibly:
  // the recurring cron ticks that followed had nothing left to do and read as
  // idle, so the feed looked dead on exactly the days files DID go out. The
  // cron route does NOT set this — it composes its own richer run row.
  recordRunAs?: string;
}): Promise<SupplierUploadSweep> {
  const startedAt = Date.now();
  if (!(await getSupplierBatchSendEnabled())) return EMPTY_SWEEP;

  // Below-cutoff orders are not delivered — and a file landing in the
  // supplier's folder IS delivery, whether or not an email ever mentions it.
  // Gated here as well as at enqueue and send because this sweep is reachable
  // from paths that re-arm rows they didn't create (see supplier-send-cutoff.ts).
  // Applies to the targeted styleIds form too: the per-style callers are
  // approvals, cover regens and folder picks, none of which are a decision to
  // deliver an order the cutoff excludes. The manual per-style push buttons do
  // not come through this lib and are unaffected.
  const cutoffWhere = deliverablePoWhere(await getSupplierSendMinPo());

  const items = await db.supplierSendQueueItem.findMany({
    where: {
      ...cutoffWhere,
      // The sent-retry lease only bounds the GLOBAL cron sweep (it exists so a
      // gap nobody fixes stops churning Graph after a week). A push targeted at
      // specific styles is a deliberate act — an approval, the operator picking
      // a PO folder, a cover regen — so it retries that style's sent rows
      // regardless of how long ago they aged out.
      ...(opts?.styleIds && opts.styleIds.length > 0
        ? { styleId: { in: opts.styleIds } }
        : { OR: [{ sentAt: null }, { queuedAt: { gte: new Date(Date.now() - SENT_RETRY_LEASE_MS) } }] }),
      sharePointStatus: { not: "UPLOADED" },
      ...(opts?.includeFloated
        ? {}
        : { NOT: { sharePointStatus: "FAILED", pushAttempts: { gte: MAX_PUSH_ATTEMPTS } } }),
    },
    select: { id: true, styleId: true, variantKey: true, jobAssetId: true, notifySupplier: true },
    orderBy: { queuedAt: "asc" },
  });
  if (items.length === 0) return EMPTY_SWEEP;

  const byStyle = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byStyle.get(it.styleId) ?? [];
    arr.push(it);
    byStyle.set(it.styleId, arr);
  }

  // Customers who deliver their own goods (skipSupplierDelivery) must never
  // have files land in a supplier folder — mirror the delivery gate in
  // publishApprovedJob.
  const styleRows = await db.style.findMany({
    where: { id: { in: [...byStyle.keys()] } },
    select: { id: true, customer: { select: { config: true } } },
  });
  const skipDeliveryByStyle = new Map(
    styleRows.map((s) => [s.id, parseCustomerConfig(s.customer.config).skipSupplierDelivery]),
  );

  const sweep: SupplierUploadSweep = {
    styles: byStyle.size,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    noFolder: 0,
    ambiguous: 0,
    failures: [],
  };
  const now = () => new Date();

  // Persist the last push error on the row, in its OWN guarded update so a
  // missing sharePointError column (before db:deploy runs the migration) can
  // never break the core status stamp above. Cleared (null) on success.
  const recordError = async (ids: string[], message: string | null) => {
    if (ids.length === 0) return;
    await db.supplierSendQueueItem
      .updateMany({ where: { id: { in: ids } }, data: { sharePointError: message } })
      .catch(() => {});
  };

  // FAILED counts a strike (pushAttempts++); every other flagged status is a
  // data/folder gap that failed fast — stamped without a strike so it keeps
  // self-healing (retried each sweep until the underlying gap is closed).
  const counterOf: Record<StampStatus, "failed" | "skipped" | "noFolder" | "ambiguous"> = {
    FAILED: "failed",
    SKIPPED: "skipped",
    NO_FOLDER: "noFolder",
    AMBIGUOUS: "ambiguous",
  };

  for (const [styleId, styleItems] of byStyle) {
    // folderMatches (JSON string of competing folders) rides ONLY on AMBIGUOUS;
    // every other status clears it, so a row that was ambiguous and is now
    // resolved doesn't keep stale links.
    const stamp = async (
      ids: string[],
      status: StampStatus,
      folderMatches?: string | null,
      errorMessage?: string | null,
    ) => {
      if (ids.length === 0) return;
      await db.supplierSendQueueItem
        .updateMany({
          where: { id: { in: ids } },
          data: {
            sharePointStatus: status,
            lastPushAt: now(),
            sharePointFolderMatches: status === "AMBIGUOUS" ? folderMatches ?? null : null,
            ...(status === "FAILED" ? { pushAttempts: { increment: 1 } } : {}),
          },
        })
        .catch(() => {});
      await recordError(ids, errorMessage ?? null);
      sweep[counterOf[status]] += ids.length;
    };

    if (skipDeliveryByStyle.get(styleId)) {
      await stamp(
        styleItems.map((i) => i.id),
        "SKIPPED",
      );
      continue;
    }

    // Rows without a surviving asset reference can't produce a PDF — settle
    // them as SKIPPED instead of leaving them forever-pending.
    const withAsset = styleItems.filter((i) => i.jobAssetId != null);
    await stamp(
      styleItems.filter((i) => i.jobAssetId == null).map((i) => i.id),
      "SKIPPED",
    );
    if (withAsset.length === 0) continue;

    // Expand each slot to ALL of its current approved + print-safe documents
    // (a carton X-of-Y is several PDFs behind one queue row). Falls back to
    // the stored representative when current-outputs can't resolve the slot —
    // the old behaviour, still correct for single-document outputs.
    const docIdsByItem = new Map<string, string[]>();
    try {
      const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
      const outputs = await getCurrentOutputsForStyle(styleId);
      const approvedByBase = new Map<string, string[]>();
      for (const o of outputs) {
        if (o.jobAssetId == null) continue;
        if (o.reviewStatus !== "APPROVED" || o.placeholderCount > 0) continue;
        const b = o.variantKey.split("#")[0] || `doc:${o.docType}`;
        const arr = approvedByBase.get(b) ?? [];
        arr.push(o.jobAssetId);
        approvedByBase.set(b, arr);
      }
      for (const item of withAsset) {
        const docs = approvedByBase.get(item.variantKey);
        docIdsByItem.set(item.id, docs && docs.length > 0 ? docs : [item.jobAssetId as string]);
      }
    } catch {
      for (const item of withAsset) docIdsByItem.set(item.id, [item.jobAssetId as string]);
    }

    const allAssetIds = [...new Set([...docIdsByItem.values()].flat())];

    try {
      const res = await pushApprovedAssetsToSupplier({ styleId, assetIds: allAssetIds });
      const uploadedByAsset = new Map<string, string | null>();
      for (const f of res.pushed) uploadedByAsset.set(f.assetId, f.webUrl);
      for (const item of withAsset) {
        const docIds = docIdsByItem.get(item.id) ?? [];
        // The slot is UPLOADED only when EVERY one of its documents landed.
        if (docIds.length > 0 && docIds.every((id) => uploadedByAsset.has(id))) {
          // Guarded on the representative we EXPANDED from: a concurrent
          // approval in this slot re-arms the row (enqueueApprovedAsset swaps
          // jobAssetId) while this push is mid-flight with a doc set that
          // predates it. Stamping unconditionally would mark the slot UPLOADED
          // without the newest file and nothing would ever re-push it. When the
          // guard misses, the row simply stays PENDING and the next sweep
          // re-expands with the full set (PUT overwrites, so re-pushing the
          // files that did land is idempotent).
          const stamped = await db.supplierSendQueueItem
            .updateMany({
              where: { id: item.id, jobAssetId: item.jobAssetId },
              data: {
                sharePointStatus: "UPLOADED",
                sharePointUrl: uploadedByAsset.get(docIds[0]) ?? res.targetFolderUrl,
                // The APPROVED LAYOUTS subfolder — deep-linked from
                // /settings/approved and re-checked by the self-heal verify.
                sharePointFolderUrl: res.targetFolderUrl,
                sharePointFolderMatches: null, // resolved — drop any prior ambiguity links
                // Deliberately NOT verified: WS4 confirms the files by listing
                // the real folder on a later tick. A push pre-stamping itself
                // as verified left race-lost files unchecked until the 24h TTL
                // — by which time the midnight digest had already claimed them.
                sharePointVerifiedAt: null,
                lastPushAt: now(),
                // A row the supplier is NOT being emailed about has no later
                // event to settle it — the digest is what normally stamps
                // sentAt, and it skips these. Landing the file IS the whole
                // job for such a row, so it settles here. Without this a silent
                // cover would sit "pending" on /settings/approved forever and
                // keep re-entering the sweep.
                ...(item.notifySupplier ? {} : { sentAt: now() }),
              },
            })
            .catch(() => ({ count: 0 }));
          if (stamped.count > 0) {
            await recordError([item.id], null); // landed cleanly — drop any prior error
            sweep.uploaded += 1;
          }
        } else {
          // Asset no longer approved/print-safe (or gone) — data-shaped skip.
          await stamp([item.id], "SKIPPED");
        }
      }
    } catch (err) {
      // Folder-shaped refusals get their own flag so /style + /settings/approved
      // can say WHY (PO folder missing / ambiguous) and the row keeps re-checking
      // each sweep. 403 (write not granted) + unexpected Graph/network errors are
      // retryable → FAILED. Other SupplierPushErrors (no supplier linked, no
      // folder link on file, nothing pushable) are data gaps → SKIPPED.
      let status: StampStatus;
      let folderMatches: string | null = null;
      if (err instanceof SupplierPushError && err.kind === "no-folder") status = "NO_FOLDER";
      else if (err instanceof SupplierPushError && err.kind === "ambiguous-folder") {
        status = "AMBIGUOUS";
        folderMatches = err.folderMatches ? JSON.stringify(err.folderMatches) : null;
      } else status = !(err instanceof SupplierPushError) || err.httpStatus === 403 ? "FAILED" : "SKIPPED";

      // The reason, persisted on the row + surfaced in the sweep result: HTTP
      // status (when known) plus the message, so "gave up (3×)" becomes
      // e.g. "400 · The file name … is invalid".
      const httpStatus = err instanceof SupplierPushError ? err.httpStatus : undefined;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = `${httpStatus ? `${httpStatus} · ` : ""}${rawMessage}`.replace(/\s+/g, " ").trim().slice(0, 500);

      await stamp(withAsset.map((i) => i.id), status, folderMatches, message);
      sweep.failures.push({ styleId, status, message });
      console.warn(`[supplier-upload] push not completed for style ${styleId} (${status}): ${message}`);
    }
  }

  // Make event-driven sweeps visible on /automation (see recordRunAs above).
  // Fail-soft: a run-record hiccup must never break the approval that
  // triggered the push.
  if (opts?.recordRunAs && sweep.styles > 0) {
    await db.cronRun
      .create({
        data: {
          kind: "supplier-upload",
          source: opts.recordRunAs,
          note:
            `uploads: ${sweep.uploaded} ok / ${sweep.failed} failed / ${sweep.skipped} skipped` +
            (sweep.noFolder > 0 || sweep.ambiguous > 0
              ? ` / ${sweep.noFolder} no PO folder / ${sweep.ambiguous} ambiguous`
              : "") +
            (sweep.failures.length > 0 ? ` — e.g. ${sweep.failures[0].message}` : ""),
          processed: sweep.uploaded,
          failed: sweep.failed,
          durationMs: Date.now() - startedAt,
        },
      })
      .catch(() => {});
  }

  return sweep;
}
