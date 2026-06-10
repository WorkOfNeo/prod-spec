import { escapeHtml } from "@/lib/pdf/templates/base";

// Shared little context table (customer / business area / PO / style) used
// by all three notification emails so the reviewer and the supplier read
// the same order identification block.
function contextRows(input: {
  styleName?: string | null;
  styleNumber?: string | null;
  customerName?: string | null;
  businessArea?: string | null;
  poNumber?: string | null;
}): { html: string; text: string[] } {
  const rows: Array<[string, string]> = [];
  if (input.customerName) rows.push(["Customer", input.customerName]);
  if (input.businessArea) rows.push(["Business area", input.businessArea]);
  if (input.poNumber) rows.push(["Order (PO)", input.poNumber]);
  if (input.styleName) rows.push(["Style", input.styleName]);
  if (input.styleNumber) rows.push(["Style no.", input.styleNumber]);
  const html = `
      <table style="margin: 12px 0; border-collapse: collapse;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding: 4px 12px 4px 0; color: #666;">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
          )
          .join("\n        ")}
      </table>`;
  const text = rows.map(([label, value]) => `${label}: ${value}`);
  return { html, text };
}

function ctaButton(href: string, label: string): string {
  return `
      <p style="margin-top: 24px;">
        <a href="${href}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           ${escapeHtml(label)}
        </a>
      </p>`;
}

// "Hey, there is something ready for you in the platform" — sent to the
// internal reviewer when a job finishes generating. Deep-links to the
// review screen where each output is approved / rejected individually.
export function reviewNotificationEmail(input: {
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  reviewUrl: string;
  // Human labels of the generated outputs, e.g.
  // "Carton marking · 150×75 mm". Shown so the reviewer knows what to
  // expect before clicking through.
  outputNames: string[];
}): { subject: string; html: string; text: string } {
  const where = [input.customerName, input.businessArea].filter(Boolean).join(" · ");
  const subject = `[Prod Spec] ${where} — ${input.styleName} ready for review`;
  const ctx = contextRows(input);
  const outputsHtml =
    input.outputNames.length > 0
      ? `<p style="margin: 4px 0 0; color: #444;">${input.outputNames.map((n) => escapeHtml(n)).join(" &nbsp;·&nbsp; ")}</p>`
      : "";
  const count = input.outputNames.length;
  const text = [
    `${count} document${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} ready for review in the platform.`,
    "",
    ...ctx.text,
    ...(input.outputNames.length > 0 ? ["", "Documents:", ...input.outputNames.map((n) => `- ${n}`)] : []),
    "",
    `Open: ${input.reviewUrl}`,
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(input.styleName)}</h2>
      <p style="color: #666; margin: 0 0 16px;">Hey — ${count} document${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} just generated and ${count === 1 ? "is" : "are"} ready for you in the platform.</p>
      ${ctx.html}
      ${outputsHtml}
      ${ctaButton(input.reviewUrl, "Open review screen")}
      <p style="color: #999; font-size: 12px; margin-top: 16px;">Approve or reject each output individually. Rejections (with your comment) land in the admin rejection log.</p>
    </div>
  `;
  return { subject, html, text };
}

// "The output you rejected has been reworked" — sent to the internal
// reviewer by the rejection log's "Mark fixed & notify" action. Quotes the
// original complaint so they know exactly what to re-check.
export function ticketFixedEmail(input: {
  outputName: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  comment: string;
  rejectedAtLabel?: string | null;
  reviewUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `[Prod Spec] Fixed — ${input.outputName} on ${input.styleName}, ready for re-review`;
  const ctx = contextRows({
    customerName: input.customerName,
    businessArea: input.businessArea,
    poNumber: input.poNumber,
    styleNumber: input.styleNumber,
  });
  const attribution = input.rejectedAtLabel ? `— rejected ${input.rejectedAtLabel}` : "— original rejection comment";
  const text = [
    `The output you rejected has been reworked and re-generated:`,
    "",
    `Output: ${input.outputName}`,
    ...ctx.text,
    "",
    `Original comment: ${input.comment}`,
    "",
    `Re-review: ${input.reviewUrl}`,
    "",
    "Approving it closes the rejection ticket automatically. Rejecting it again reopens the ticket with your new comment.",
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(input.outputName)}</h2>
      <p style="color: #444; margin: 0 0 12px;">The output you rejected has been reworked and re-generated.</p>
      <blockquote style="border-left: 3px solid #e4e4e7; background: #fafafa; padding: 8px 12px; margin: 0 0 4px; color: #52525b; font-size: 13px; border-radius: 0 6px 6px 0;">
        ${escapeHtml(input.comment)}
        <div style="color: #a1a1aa; font-size: 11px; margin-top: 4px;">${escapeHtml(attribution)}</div>
      </blockquote>
      ${ctx.html}
      ${ctaButton(input.reviewUrl, "Re-review now")}
      <p style="color: #999; font-size: 12px; margin-top: 16px;">Approving it closes the rejection ticket automatically. Rejecting it again reopens the ticket with your new comment.</p>
    </div>
  `;
  return { subject, html, text };
}

export function supplierApprovalEmail(input: {
  supplierEmail: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  // webUrl is null when SharePoint isn't configured — the files then only
  // travel as attachments and the list renders as plain names.
  files: Array<{ name: string; webUrl: string | null }>;
  // SharePoint folder the files were published to. When present it's
  // surfaced as a button + plain-text link; the files are also attached.
  folderUrl?: string | null;
  isCorrection?: boolean;
}): { subject: string; html: string; text: string } {
  const prefix = input.isCorrection ? "[Correction] " : "";
  const subject = `${prefix}ProdSpec — ${input.styleName} (${input.styleNumber}) — ready for review`;
  const intro = input.isCorrection
    ? "An updated set of ProdSpec files has been published for the order below and is ready to be reviewed. The previous files have been overwritten."
    : "The ProdSpec files for the order below are ready to be reviewed.";
  const whereToFind = input.folderUrl
    ? "You can find them in the SharePoint folder linked below; the files are also attached to this email."
    : "The files are attached to this email.";
  const fileLinks = input.files
    .map((f) => (f.webUrl ? `<li><a href="${f.webUrl}">${escapeHtml(f.name)}</a></li>` : `<li>${escapeHtml(f.name)}</li>`))
    .join("");
  const folderButton = input.folderUrl ? ctaButton(input.folderUrl, "Open SharePoint folder") : "";
  const ctx = contextRows(input);

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <p>${intro}</p>
      <p style="color: #444;">${whereToFind}</p>
      ${ctx.html}
      ${folderButton}
      <h3 style="margin: 24px 0 8px;">Files</h3>
      <ul style="padding-left: 18px;">${fileLinks}</ul>
    </div>
  `;
  const text = [
    intro,
    whereToFind,
    "",
    ...ctx.text,
    ...(input.folderUrl ? ["", `SharePoint folder: ${input.folderUrl}`] : []),
    "",
    "Files:",
    ...input.files.map((f) => (f.webUrl ? `- ${f.name}: ${f.webUrl}` : `- ${f.name}`)),
  ].join("\n");

  return { subject, html, text };
}
