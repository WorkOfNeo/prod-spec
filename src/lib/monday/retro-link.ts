import { db } from "@/lib/db";
import { MONDAY_BOARDS, MONDAY_PRE_ORDER_COLS, MONDAY_STYLE_COLS } from "./boards";
import { columnValue, type MondayColumnValue, type MondayItem } from "./client";
import { extractLinkedItemId } from "@/lib/import/heuristics";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { autoEnqueueReadyOutputs } from "@/lib/queue/auto-enqueue";
import { triggerRunner } from "@/lib/queue/trigger";
import { slog } from "./sync-log";

// =====================================================
// Late-supplier retro-link.
//
// Style ingest resolves the supplier link ONCE, at style-upsert time: the
// Monday item id in the row's supplier column is looked up in the local
// `suppliers` mirror, and a miss leaves Style.supplierId NULL. A supplier
// created on Monday AFTER its styles were ingested therefore never links —
// nothing looks back — and every downstream supplier surface breaks: the
// SharePoint push 409s ("no linked supplier"), the nightly digest groups the
// outputs under "no supplier linked", and countryOfOrigin loses its supplier
// fallback. (Root case diagnosed 2026-07-16 — the supplier boards accept no
// webhooks for our user, so late suppliers are the norm, not the exception.)
//
// This sweep runs after every supplier fill: re-resolve each unlinked
// style's supplier column against the (now fresher) mirror, then repair the
// two places that captured the NULL — the style row itself and its unsent
// supplier-send queue rows (which freeze supplierId at approve time) — and
// auto-enqueue any outputs the link just made ready, through the same T6
// gate every other ingest path uses.
// =====================================================

export type RetroLinkResult = {
  // Unlinked styles that DO carry a supplier link on their Monday row.
  candidates: number;
  // How many of those resolved against the suppliers mirror this run.
  linked: number;
  queueRowsUpdated: number;
  jobsEnqueued: number;
};

export async function retroLinkStyleSuppliers(): Promise<RetroLinkResult> {
  // Per source board: which column carries the supplier board-relation.
  // MONDAY_STYLE_COLS.supplierLink defaults "" (legacy board, unconfigured) —
  // skip sources without a configured column.
  const sources = [
    { boardId: MONDAY_BOARDS.preOrder, colId: MONDAY_PRE_ORDER_COLS.supplierLink },
    { boardId: MONDAY_BOARDS.styles, colId: MONDAY_STYLE_COLS.supplierLink },
  ].filter((s) => s.colId);

  // Pull ONLY the supplier column of each unlinked style, extracted DB-side —
  // fetching whole rawData blobs for every unlinked style would move
  // megabytes to resolve a handful of ids.
  const found = new Map<string, string>(); // styleId -> linked Monday item id
  for (const { boardId, colId } of sources) {
    const rows = await db.$queryRaw<Array<{ id: string; cv: unknown }>>`
      SELECT s.id, cv
      FROM styles s,
      LATERAL jsonb_array_elements(s."rawData"->'column_values') cv
      WHERE s."supplierId" IS NULL
        AND s."deletedAt" IS NULL
        AND s."archivedAt" IS NULL
        AND s."mondayBoardId" = ${boardId}
        AND cv->>'id' = ${colId}
    `;
    for (const row of rows) {
      // Reuse the ingest-path readers so legacy `value.linkedPulseIds` and
      // API-2024-10 `linked_item_ids` rows resolve identically here.
      const item = {
        id: "",
        name: "",
        board: { id: boardId },
        column_values: [row.cv as MondayColumnValue],
      } satisfies MondayItem;
      const linkedId = extractLinkedItemId(columnValue(item, colId));
      if (linkedId) found.set(row.id, linkedId);
    }
  }

  if (found.size === 0) {
    return { candidates: 0, linked: 0, queueRowsUpdated: 0, jobsEnqueued: 0 };
  }

  const suppliers = await db.supplier.findMany({
    where: { mondayItemId: { in: [...new Set(found.values())] } },
    select: { id: true, mondayItemId: true },
  });
  const supplierByMondayId = new Map(suppliers.map((s) => [s.mondayItemId, s.id]));

  // Group the resolvable styles per supplier so both repairs are one
  // updateMany per supplier instead of per style.
  const styleIdsBySupplier = new Map<string, string[]>();
  for (const [styleId, mondayId] of found) {
    const supplierId = supplierByMondayId.get(mondayId);
    if (!supplierId) continue; // supplier still not mirrored — next run
    const list = styleIdsBySupplier.get(supplierId) ?? [];
    list.push(styleId);
    styleIdsBySupplier.set(supplierId, list);
  }

  let linked = 0;
  let queueRowsUpdated = 0;
  const linkedStyleIds: string[] = [];
  for (const [supplierId, styleIds] of styleIdsBySupplier) {
    const res = await db.style.updateMany({
      where: { id: { in: styleIds }, supplierId: null },
      data: { supplierId },
    });
    linked += res.count;
    linkedStyleIds.push(...styleIds);
    // Unsent queue rows froze supplierId NULL at approve time; without this
    // the folder push works (it re-reads the style) but the digest email
    // still files the outputs under "— no supplier linked".
    const q = await db.supplierSendQueueItem.updateMany({
      where: { styleId: { in: styleIds }, supplierId: null, sentAt: null },
      data: { supplierId },
    });
    queueRowsUpdated += q.count;
  }

  // The link can flip readiness (countryOfOrigin falls back to the supplier's
  // country) — run the newly-linked styles through the shared auto-enqueue
  // gate. Master switch read once; runner kicked once (bulk-loop pattern).
  let jobsEnqueued = 0;
  if (linkedStyleIds.length > 0) {
    const autoGenerateEnabled = await getAutoGenerateEnabled();
    const styles = await db.style.findMany({
      where: { id: { in: linkedStyleIds } },
      select: { id: true, prodSpec: { select: { active: true } } },
    });
    for (const style of styles) {
      const enqueue = await autoEnqueueReadyOutputs({
        styleId: style.id,
        prodSpecActive: style.prodSpec?.active ?? false,
        triggerSource: "CRON_SWEEP",
        autoGenerateEnabled,
      });
      if (enqueue.enqueued) jobsEnqueued++;
    }
    if (jobsEnqueued > 0) await triggerRunner();
  }

  const result = { candidates: found.size, linked, queueRowsUpdated, jobsEnqueued };
  slog("retro-link", "supplier retro-link done", result);
  return result;
}
