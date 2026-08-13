// Leaf module — builds an admin-written follow-up email to a supplier, in the
// same house style as the nightly digest so a correction doesn't arrive looking
// like it came from somewhere else. DB-free (like supplier-digest.ts) so the
// route and the tests can import it without the Prisma client.
//
// The admin writes plain text; this turns it into the table-based, inline-styled
// HTML that survives Gmail and Outlook, and returns the plain-text arm as typed.
// Nothing here interprets the body — no templating, no token substitution — so
// what the admin reads back in the dialog is exactly what the supplier gets.

// Same four-replace escaper as the digest — this module stays dependency-free.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Email-safe palette, shared with the digest (literal hex — email clients don't
// do CSS variables).
const INK = "#18181b";
const FAINT = "#a1a1aa";
const LINE = "#e4e4e7";
const PAGE_BG = "#f4f4f5";

export type SupplierMessage = { subject: string; html: string; text: string };

// {{supplier}} is the one substitution, so a single body can greet 40 suppliers
// by name. Deliberately the ONLY one: every other token would be a thing the
// admin can't verify in the preview.
export const SUPPLIER_NAME_TOKEN = "{{supplier}}";

export function applySupplierName(template: string, supplierName: string): string {
  return template.split(SUPPLIER_NAME_TOKEN).join(supplierName);
}

// Split the typed body into paragraphs on blank lines; single newlines inside a
// paragraph become <br>, so a pasted address block or a short list survives.
function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function buildSupplierMessage(input: {
  supplierName: string;
  subject: string;
  body: string;
}): SupplierMessage {
  const subject = applySupplierName(input.subject, input.supplierName).trim();
  const body = applySupplierName(input.body, input.supplierName);

  const blocks = paragraphs(body)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#3f3f46">${esc(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");

  const html =
    `<div style="margin:0;padding:24px 12px;background:${PAGE_BG};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">` +
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden">` +
    // Header — the subject IS the headline; a follow-up has no count to report.
    `<tr><td style="padding:22px 28px 18px;border-bottom:1px solid ${LINE}">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${FAINT}">Prod Spec</div>` +
    `<div style="margin-top:6px;font-size:19px;font-weight:600;color:${INK}">${esc(subject)}</div>` +
    `</td></tr>` +
    `<tr><td style="padding:22px 28px 26px">` +
    `<p style="margin:0 0 12px;font-size:14px;color:${INK}">Hi ${esc(input.supplierName)},</p>` +
    blocks +
    `</td></tr>` +
    `<tr><td style="padding:16px 28px 22px;border-top:1px solid ${LINE}">` +
    `<div style="font-size:12px;color:${FAINT}">Sent by Prod Spec on behalf of Contrast. Reply to this email if anything looks off.</div>` +
    `</td></tr>` +
    `</table></td></tr></table></div>`;

  const text = [`Hi ${input.supplierName},`, ``, body.trim(), ``, `Sent by Prod Spec on behalf of Contrast.`].join("\n");

  return { subject, html, text };
}
