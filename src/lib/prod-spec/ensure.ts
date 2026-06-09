import { db } from "@/lib/db";
import { DEFAULT_OUTPUTS } from "./config";

// Idempotently create a ProdSpec row for (customerId, businessAreaId).
// Returns true if a new row was created, false if it already existed.
//
// Defaults:
//   - name: "<Customer name> · <BusinessArea name>"
//   - outputs: [] — operator picks variants in the editor
//   - columnMapping: {} → inherits from Customer.config.columnMapping
//   - requiredFields: [] → inherits from Customer.config.requiredFields
//   - autoGenerateThresholdPct: 100
//   - active: false — auto-created scaffolds sit in "needs configuration"
//     on /import until an admin reviews and saves the ProdSpec (the
//     PATCH endpoint auto-activates on any non-active field change).
export async function ensureProdSpecsForStyle(
  customerId: string,
  businessAreaId: string,
): Promise<boolean> {
  const existing = await db.prodSpec.findUnique({
    where: { customerId_businessAreaId: { customerId, businessAreaId } },
  });
  if (existing) return false;

  const [customer, businessArea] = await Promise.all([
    db.customer.findUnique({ where: { id: customerId } }),
    db.businessArea.findUnique({ where: { id: businessAreaId } }),
  ]);

  const name = `${customer?.name ?? "Unknown"} · ${businessArea?.name ?? "Unknown"}`;

  await db.prodSpec.create({
    data: {
      customerId,
      businessAreaId,
      name,
      outputs: DEFAULT_OUTPUTS as unknown as object,
      columnMapping: {} as object,
      requiredFields: [] as unknown as object,
      autoGenerateThresholdPct: 100,
      active: false,
    },
  });
  return true;
}

// Back-fills Style.prodSpecId for any rows already in the local mirror
// whose (customerId, businessAreaId) matches the freshly-created/located
// ProdSpec and whose link is still null. Returns the row count touched.
//
// Why: Style ingest *sets* prodSpecId only at upsert time. ProdSpecs
// created after the matching Styles already ingested (manual + wizard
// flow) would otherwise leave those Styles unlinked until the next
// ingest. This helper closes that gap on demand.
export async function backfillStyleProdSpecLinks(
  customerId: string,
  businessAreaId: string,
): Promise<number> {
  const prodSpec = await db.prodSpec.findUnique({
    where: { customerId_businessAreaId: { customerId, businessAreaId } },
    select: { id: true },
  });
  if (!prodSpec) return 0;
  const res = await db.style.updateMany({
    where: { customerId, businessAreaId, prodSpecId: null },
    data: { prodSpecId: prodSpec.id },
  });
  return res.count;
}
