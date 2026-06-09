import { escapeHtml } from "@/lib/pdf/templates/base";

export function reviewNotificationEmail(input: {
  styleName: string;
  styleNumber: string;
  customerName: string;
  reviewUrl: string;
  documentCount: number;
}): { subject: string; html: string; text: string } {
  const subject = `[Prod Spec] ${input.styleName} ready for review`;
  const text = [
    `${input.documentCount} documents are ready for review on ${input.styleName} (${input.styleNumber}) — ${input.customerName}.`,
    "",
    `Open: ${input.reviewUrl}`,
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(input.styleName)}</h2>
      <p style="color: #666; margin: 0 0 16px;">Style ${escapeHtml(input.styleNumber)} · ${escapeHtml(input.customerName)}</p>
      <p>${input.documentCount} documents are ready for your review.</p>
      <p style="margin-top: 24px;">
        <a href="${input.reviewUrl}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           Open review screen
        </a>
      </p>
    </div>
  `;
  return { subject, html, text };
}

export function supplierApprovalEmail(input: {
  supplierEmail: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  files: Array<{ name: string; webUrl: string }>;
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
  const fileLinks = input.files.map((f) => `<li><a href="${f.webUrl}">${escapeHtml(f.name)}</a></li>`).join("");
  const folderButton = input.folderUrl
    ? `<p style="margin: 16px 0;">
         <a href="${input.folderUrl}"
            style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
            Open SharePoint folder
         </a>
       </p>`
    : "";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <p>${intro}</p>
      <p style="color: #444;">${whereToFind}</p>
      <table style="margin: 12px 0; border-collapse: collapse;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Style</td><td>${escapeHtml(input.styleName)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Number</td><td>${escapeHtml(input.styleNumber)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Customer</td><td>${escapeHtml(input.customerName)}</td></tr>
      </table>
      ${folderButton}
      <h3 style="margin: 24px 0 8px;">Files</h3>
      <ul style="padding-left: 18px;">${fileLinks}</ul>
    </div>
  `;
  const text = [
    intro,
    whereToFind,
    "",
    `Style: ${input.styleName} (${input.styleNumber}) · ${input.customerName}`,
    ...(input.folderUrl ? ["", `SharePoint folder: ${input.folderUrl}`] : []),
    "",
    "Files:",
    ...input.files.map((f) => `- ${f.name}: ${f.webUrl}`),
  ].join("\n");

  return { subject, html, text };
}
