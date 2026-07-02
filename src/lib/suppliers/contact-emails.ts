import { db } from "@/lib/db";
import { RECIPIENT_CONTACT_TYPE, RECIPIENT_STATUS } from "./recipients";

// Emails of the sendable contacts for a batch of suppliers, keyed by
// supplierId — Active "Product Supplier" people from the Supplier Contacts
// board (see ./recipients.ts for the resolution rule). The supplier_contacts
// table is an additive migration — until `db:deploy` runs on the live DB
// this read would 500 the whole caller, so it degrades to an empty map
// (callers then resolve exactly as before the contacts board existed).
export async function loadContactEmailsBySupplier(
  supplierIds: string[],
): Promise<Map<string, string[]>> {
  const ids = [...new Set(supplierIds)].filter(Boolean);
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  try {
    const contacts = await db.supplierContact.findMany({
      where: {
        supplierId: { in: ids },
        active: true,
        status: RECIPIENT_STATUS,
        contactType: RECIPIENT_CONTACT_TYPE,
        email: { not: null },
      },
      orderBy: { name: "asc" },
      select: { supplierId: true, email: true },
    });
    for (const c of contacts) {
      const email = c.email?.trim();
      if (!email || !c.supplierId) continue;
      const arr = map.get(c.supplierId) ?? [];
      if (!arr.some((e) => e.toLowerCase() === email.toLowerCase())) arr.push(email);
      map.set(c.supplierId, arr);
    }
  } catch (err) {
    console.warn(
      "[supplier-recipients] contact lookup failed (table not deployed yet?) — falling back to Supplier.email/contactEmail:",
      (err as Error).message,
    );
  }
  return map;
}
