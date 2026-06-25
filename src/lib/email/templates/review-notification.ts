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

// Batched sibling of ticketFixedEmail — the rejection log's style-level
// "Mark fixed & notify" / "Regenerate all & mark fixed" resolves several of a
// style's rejected outputs at once and sends ONE re-review notice listing
// them, rather than one email per output.
export function ticketsFixedEmail(input: {
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  // Human labels of the outputs just marked fixed, e.g. "Carton marking".
  outputNames: string[];
  reviewUrl: string;
}): { subject: string; html: string; text: string } {
  const n = input.outputNames.length;
  const subject = `[Prod Spec] ${n} output${n === 1 ? "" : "s"} fixed on ${input.styleName}, ready for re-review`;
  const ctx = contextRows({
    customerName: input.customerName,
    businessArea: input.businessArea,
    poNumber: input.poNumber,
    styleNumber: input.styleNumber,
  });
  const text = [
    `${n} output${n === 1 ? "" : "s"} you rejected ${n === 1 ? "has" : "have"} been reworked and re-generated:`,
    "",
    ...input.outputNames.map((o) => `- ${o}`),
    ...ctx.text,
    "",
    `Re-review: ${input.reviewUrl}`,
    "",
    "Approving each one closes its rejection ticket automatically. Rejecting again reopens the ticket with your new comment.",
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(input.styleName)}</h2>
      <p style="color: #444; margin: 0 0 12px;">${n} output${n === 1 ? "" : "s"} you rejected ${n === 1 ? "has" : "have"} been reworked and re-generated:</p>
      <ul style="margin: 0 0 4px; padding-left: 20px; color: #52525b; font-size: 13px;">
        ${input.outputNames.map((o) => `<li>${escapeHtml(o)}</li>`).join("\n        ")}
      </ul>
      ${ctx.html}
      ${ctaButton(input.reviewUrl, "Re-review now")}
      <p style="color: #999; font-size: 12px; margin-top: 16px;">Approving each one closes its rejection ticket automatically. Rejecting again reopens the ticket with your new comment.</p>
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
  // The supplier-only link to view the approved PDFs, plus the 4-digit PIN
  // they must enter (along with their email) to unlock it. The whole point
  // of the email when SharePoint isn't live yet.
  shareUrl: string;
  sharePin: string;
  // SharePoint folder the files were published to. When present it's
  // surfaced as a button + plain-text link; the files are also attached.
  // SharePoint isn't live yet ("soon"), so we always TELL the supplier the
  // files will be in their SharePoint folder, but only link it when real.
  folderUrl?: string | null;
  // Certification marks the supplier must apply to the labels/packaging
  // (e.g. ["FSC", "OEKOTEX"]) — the style's resolved certificates (T10).
  // Omitted/empty ⇒ the section is not rendered.
  certificates?: string[];
  isCorrection?: boolean;
}): { subject: string; html: string; text: string } {
  const prefix = input.isCorrection ? "[Correction] " : "";
  const subject = `${prefix}ProdSpec — ${input.styleName} (${input.styleNumber}) — ready for review`;
  const intro = input.isCorrection
    ? "An updated set of ProdSpec files has been published for the order below and is ready to be reviewed. The previous files have been overwritten."
    : "The ProdSpec files for the order below are ready to be reviewed.";
  const fileLinks = input.files
    .map((f) => (f.webUrl ? `<li><a href="${f.webUrl}">${escapeHtml(f.name)}</a></li>` : `<li>${escapeHtml(f.name)}</li>`))
    .join("");
  const folderLine = input.folderUrl
    ? `You can also find them in your SharePoint supplier folder, linked below.`
    : `These files will also be saved to your SharePoint supplier folder.`;
  const folderButton = input.folderUrl ? ctaButton(input.folderUrl, "Open SharePoint folder") : "";
  const certs = (input.certificates ?? []).map((c) => c.trim()).filter(Boolean);
  const certsBlock =
    certs.length > 0
      ? `
      <h3 style="margin: 24px 0 8px;">Certificates to apply</h3>
      <p style="color: #444; margin: 0 0 8px;">This style requires the following certification mark(s). Please make sure they appear on the labels / packaging:</p>
      <ul style="padding-left: 18px; margin: 0;">${certs.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
      : "";
  const ctx = contextRows(input);

  // The link block: button + how to unlock (their email + the PIN).
  const linkBlock = `
      <p style="margin: 4px 0 10px; color: #444;">Open your secure link below. You'll be asked for your email address and this PIN:</p>
      <p style="margin: 0 0 12px; font: 600 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px; color: #111;">${escapeHtml(input.sharePin)}</p>
      ${ctaButton(input.shareUrl, "View approved prod specs")}
      <p style="margin: 8px 0 0; color: #888; font-size: 12px;">If the button doesn't work, paste this into your browser: ${escapeHtml(input.shareUrl)}</p>`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <p>${intro}</p>
      ${ctx.html}
      ${linkBlock}
      <p style="color: #444; margin-top: 18px;">${folderLine} The files are also attached to this email.</p>
      ${folderButton}
      ${certsBlock}
      <h3 style="margin: 24px 0 8px;">Files</h3>
      <ul style="padding-left: 18px;">${fileLinks}</ul>
    </div>
  `;
  const text = [
    intro,
    "",
    ...ctx.text,
    "",
    "View the approved prod specs online (you'll need your email address and PIN):",
    `Link: ${input.shareUrl}`,
    `PIN: ${input.sharePin}`,
    "",
    folderLine,
    ...(input.folderUrl ? [`SharePoint folder: ${input.folderUrl}`] : []),
    "The files are also attached to this email.",
    ...(certs.length > 0
      ? ["", "Certificates to apply (must appear on labels/packaging):", ...certs.map((c) => `- ${c}`)]
      : []),
    "",
    "Files:",
    ...input.files.map((f) => (f.webUrl ? `- ${f.name}: ${f.webUrl}` : `- ${f.name}`)),
  ].join("\n");

  return { subject, html, text };
}

// Per-output supplier email (per-output refactor, phase 3): one approved
// output rather than the whole job. Reuses the approval body with a single
// file and a per-output subject. Routed through dispatchEmail, so the email
// kill switch still blocks real sends during the test phase.
export function supplierOutputEmail(input: {
  outputName: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  file: { name: string; webUrl: string | null };
  shareUrl: string;
  sharePin: string;
  folderUrl?: string | null;
}): { subject: string; html: string; text: string } {
  const body = supplierApprovalEmail({
    supplierEmail: "",
    styleName: input.styleName,
    styleNumber: input.styleNumber,
    customerName: input.customerName,
    businessArea: input.businessArea,
    poNumber: input.poNumber,
    files: [input.file],
    shareUrl: input.shareUrl,
    sharePin: input.sharePin,
    folderUrl: input.folderUrl,
  });
  return { ...body, subject: `ProdSpec — ${input.outputName} approved (${input.styleName})` };
}

// "This style is fully approved" — sent to the person responsible toward the
// customer (the Styles board's people column, resolved to their email) once
// EVERY ProdSpec output for the style has been approved. Internal-facing
// confirmation: it states the delivery outcome to the supplier and lists the
// certificates the supplier was asked to apply, so the customer owner has the
// full picture without opening the platform.
export function customerApprovalEmail(input: {
  styleName: string;
  styleNumber?: string;
  customerName: string;
  businessArea?: string | null;
  poNumber?: string | null;
  files: Array<{ name: string; webUrl: string | null }>;
  certificates?: string[];
  // The supplier the prod specs were delivered to (To: of the supplier
  // email). Null when no supplier recipient resolved.
  supplierEmail?: string | null;
  // Deep link to the style page in the platform, if available.
  styleUrl?: string | null;
}): { subject: string; html: string; text: string } {
  const subject = `[Prod Spec] ${input.customerName} — ${input.styleName} fully approved`;
  const ctx = contextRows(input);
  const certs = (input.certificates ?? []).map((c) => c.trim()).filter(Boolean);
  const deliveryLine = input.supplierEmail
    ? `The prod-spec files have been published and delivered to the supplier (${escapeHtml(input.supplierEmail)}).`
    : `The prod-spec files have been published. No supplier recipient was on file, so forward them from the prod-spec tab if needed.`;
  const certsHtml =
    certs.length > 0
      ? `
      <h3 style="margin: 24px 0 8px;">Certificates requested from the supplier</h3>
      <ul style="padding-left: 18px; margin: 0;">${certs.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
      : "";
  const fileLinks = input.files
    .map((f) => (f.webUrl ? `<li><a href="${f.webUrl}">${escapeHtml(f.name)}</a></li>` : `<li>${escapeHtml(f.name)}</li>`))
    .join("");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(input.styleName)}</h2>
      <p style="color: #444; margin: 0 0 12px;">All ProdSpec outputs for this style have been approved.</p>
      ${ctx.html}
      <p style="color: #444; margin: 12px 0 0;">${deliveryLine}</p>
      ${certsHtml}
      <h3 style="margin: 24px 0 8px;">Approved documents</h3>
      <ul style="padding-left: 18px;">${fileLinks}</ul>
      ${input.styleUrl ? ctaButton(input.styleUrl, "Open style") : ""}
    </div>
  `;
  const text = [
    `All ProdSpec outputs for ${input.styleName} have been approved.`,
    "",
    ...ctx.text,
    "",
    input.supplierEmail
      ? `Delivered to supplier: ${input.supplierEmail}`
      : "Published — no supplier recipient on file.",
    ...(certs.length > 0
      ? ["", "Certificates requested from the supplier:", ...certs.map((c) => `- ${c}`)]
      : []),
    "",
    "Approved documents:",
    ...input.files.map((f) => (f.webUrl ? `- ${f.name}: ${f.webUrl}` : `- ${f.name}`)),
    ...(input.styleUrl ? ["", `Open style: ${input.styleUrl}`] : []),
  ].join("\n");

  return { subject, html, text };
}
