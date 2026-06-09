import { db } from "@/lib/db";
import { columnText, getItem, type MondayItem } from "./client";
import { evaluateCompletion } from "./completion";
import { resolveCustomerByBoardId, ensureNettoGermany } from "@/lib/customers/resolve";
import { parseCustomerConfig } from "@/lib/customers/config";

export type IngestResult = {
  styleId: string;
  customerId: string;
  customerSlug: string;
  completionPct: number;
  missingFields: Array<{ id: string; label: string }>;
};

export async function ingestMondayItem(itemId: string | number, item?: MondayItem | null): Promise<IngestResult> {
  const fetched = item ?? (await getItem(itemId));
  if (!fetched) throw new Error(`Monday item ${itemId} not found`);

  const resolved = await resolveCustomerByBoardId(fetched.board.id);
  // No customer claims this board — fall back to Netto Germany for M2.
  // Once Customer 2/3 are configured, this fallback should be removed.
  const customer = resolved?.customer ?? (await ensureNettoGermany());
  const config = resolved?.config ?? parseCustomerConfig(customer.config);

  const businessAreaColumn = config.columnMapping.businessArea;
  const businessArea = businessAreaColumn ? columnText(fetched, businessAreaColumn) || null : null;

  const { completionPct, missingFields } = evaluateCompletion(fetched, config.requiredFields);
  const status = completionPct === 100 ? "READY" : "PENDING";

  const style = await db.style.upsert({
    where: { mondayItemId: String(fetched.id) },
    create: {
      customerId: customer.id,
      mondayItemId: String(fetched.id),
      mondayBoardId: fetched.board.id,
      name: fetched.name,
      businessArea,
      rawData: fetched as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status,
      lastSyncedAt: new Date(),
    },
    update: {
      customerId: customer.id,
      mondayBoardId: fetched.board.id,
      name: fetched.name,
      businessArea,
      rawData: fetched as unknown as object,
      completionPct,
      missingFields: missingFields as unknown as object,
      status,
      lastSyncedAt: new Date(),
      // The item is live in Monday (it emitted this event / was returned by
      // the API), so it is no longer archived or deleted. Clear any prior flag.
      archivedAt: null,
      deletedAt: null,
    },
  });

  return {
    styleId: style.id,
    customerId: customer.id,
    customerSlug: customer.slug,
    completionPct,
    missingFields,
  };
}

export type LifecycleResult = { matched: boolean; styleId?: string };

// Soft lifecycle handlers. We never hard-delete: an archived / deleted Monday
// item is flagged so the row + its Log trail survive for audit, and the UI
// stops surfacing it. Idempotent — re-stamping an already-flagged row is fine.
export async function markStyleArchived(itemId: string | number): Promise<LifecycleResult> {
  const result = await db.style.updateMany({
    where: { mondayItemId: String(itemId), archivedAt: null },
    data: { archivedAt: new Date() },
  });
  const style = await db.style.findUnique({ where: { mondayItemId: String(itemId) }, select: { id: true } });
  return { matched: result.count > 0 || style !== null, styleId: style?.id };
}

export async function markStyleDeleted(itemId: string | number): Promise<LifecycleResult> {
  const result = await db.style.updateMany({
    where: { mondayItemId: String(itemId), deletedAt: null },
    data: { deletedAt: new Date() },
  });
  const style = await db.style.findUnique({ where: { mondayItemId: String(itemId) }, select: { id: true } });
  return { matched: result.count > 0 || style !== null, styleId: style?.id };
}
