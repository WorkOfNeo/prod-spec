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
