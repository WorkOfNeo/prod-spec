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

// A single Monday supplier field routinely packs SEVERAL addresses into one
// string — joined by commas, semicolons, newlines, or " - " (space-dash-space,
// the separator the buyers type). Handed straight to Resend, a packed field is
// one invalid recipient and the whole digest is rejected. So every source is
// split into individual addresses and validated here; a bad or packed field
// can no longer sink a supplier's send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Split on address separators: any run of comma/semicolon/newline/tab, OR a
// dash (hyphen / en / em) fenced by whitespace. A real address never contains
// " - ", so this can't cut a valid address (e.g. "a-b@x.com" is untouched).
function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/\s+[-–—]\s+|[,;\n\r\t]+/)) {
    const t = token.trim();
    if (!t) continue;
    // Accept a "Name <email@x.com>" token by pulling the bracketed address.
    const addr = (t.match(/<([^>]+)>/)?.[1] ?? t).trim();
    if (!EMAIL_RE.test(addr)) continue;
    if (!out.some((e) => e.toLowerCase() === addr.toLowerCase())) out.push(addr);
  }
  return out;
}

// Combine the mirrored Supplier fields with the synced contact emails into
// a To + CC pair. Pure so the batch send, preview, and per-output delivery
// all agree on who gets the email. Priority for To: company inbox → first
// synced contact → legacy contactEmail; every other valid address lands on
// CC once (deduped case-insensitively, To excluded).
export function combineSupplierRecipients(
  supplier: { email: string | null; contactEmail: string | null } | null | undefined,
  contactEmails: string[],
): SupplierRecipients {
  const ordered: string[] = [];
  const push = (email: string) => {
    if (!ordered.some((e) => e.toLowerCase() === email.toLowerCase())) ordered.push(email);
  };
  // Same priority as before, now split + validated per source.
  for (const e of parseEmailList(supplier?.email)) push(e);
  for (const raw of contactEmails) for (const e of parseEmailList(raw)) push(e);
  for (const e of parseEmailList(supplier?.contactEmail)) push(e);

  return { to: ordered[0] ?? null, cc: ordered.slice(1) };
}
