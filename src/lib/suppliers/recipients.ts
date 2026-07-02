// =====================================================
// Supplier email recipients — one resolution rule for every surface that
// emails a supplier (nightly batch, per-output delivery, publish logging,
// digest preview, /settings/approved summary).
//
// Recipient sources, in priority order for To:
//   1. Supplier.email        — the company inbox from the Suppliers board
//   2. first synced contact  — Active "Product Supplier" people from the
//                              Supplier Contacts board (3363269178)
//   3. Supplier.contactEmail — legacy single contact field
// Every remaining contact email goes on CC (deduped, To excluded). Callers
// keep their own SUPPLIER_NOTIFICATION_EMAIL / review-CC fallbacks on top.
//
// PURE LEAF — no db import, so tests and non-DB callers can use it. The
// contact lookup lives in ./contact-emails.ts.
// =====================================================

// Only these contacts receive supplier emails. "Cost Supplier" people and
// the junk "–" type are synced but never emailed; Passive contacts are the
// board's own "don't use anymore" flag.
export const RECIPIENT_CONTACT_TYPE = "Product Supplier";
export const RECIPIENT_STATUS = "Active";

export type SupplierRecipients = { to: string | null; cc: string[] };

// Combine the mirrored Supplier fields with the synced contact emails into
// a To + CC pair. Pure so the batch send, preview, and per-output delivery
// all agree on who gets the email.
export function combineSupplierRecipients(
  supplier: { email: string | null; contactEmail: string | null } | null | undefined,
  contactEmails: string[],
): SupplierRecipients {
  const contacts = contactEmails.map((e) => e.trim()).filter(Boolean);
  const to = supplier?.email?.trim() || contacts[0] || supplier?.contactEmail?.trim() || null;
  const cc: string[] = [];
  for (const email of [...contacts, supplier?.contactEmail?.trim() ?? ""]) {
    if (!email) continue;
    if (to && email.toLowerCase() === to.toLowerCase()) continue;
    if (cc.some((e) => e.toLowerCase() === email.toLowerCase())) continue;
    cc.push(email);
  }
  return { to, cc };
}
