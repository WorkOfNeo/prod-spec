import { escapeHtml } from "@/lib/pdf/templates/base";

// "A new Customer × Business-Area combination just appeared" — staged to the
// admin (nh@neo-labs.com) by src/lib/combos/reconcile.ts the first time a
// combo shows up among active styles, so it can get a first look and have a
// ProdSpec / PDFs built from spec. Mirrors the inline-styled card shape of
// the review-notification templates.
export function newComboEmail(input: {
  customerName: string;
  businessArea: string; // resolved BA name, free text, or "— no business area —"
  activeStyleCount: number;
  comboUrl: string; // deep link to /combos
}): { subject: string; html: string; text: string } {
  const combo = `${input.customerName} · ${input.businessArea}`;
  const subject = `[Prod Spec] New combo — ${combo}`;
  const n = input.activeStyleCount;
  const styleLine = `${n} active ${n === 1 ? "style" : "styles"}`;

  const rows: Array<[string, string]> = [
    ["Customer", input.customerName],
    ["Business area", input.businessArea],
    ["Active styles", String(n)],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 12px 4px 0; color: #666;">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
    )
    .join("\n        ");

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">New combination detected</h2>
      <p style="color: #444; margin: 0 0 12px;">A new <strong>Customer&nbsp;×&nbsp;Business&nbsp;Area</strong> combination just appeared among active styles (${escapeHtml(styleLine)}). Give it a first look and build a ProdSpec / make PDFs from spec.</p>
      <table style="margin: 12px 0; border-collapse: collapse;">
        ${rowsHtml}
      </table>
      <p style="margin-top: 24px;">
        <a href="${input.comboUrl}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           Review combos
        </a>
      </p>
      <p style="color: #999; font-size: 12px; margin-top: 16px;">You're getting this because a Customer × Business-Area pair appeared that wasn't on the list before. Mark it reviewed on the dashboard once it's handled.</p>
    </div>
  `;
  const text = [
    `A new Customer × Business Area combination just appeared among active styles (${styleLine}).`,
    "",
    `Customer: ${input.customerName}`,
    `Business area: ${input.businessArea}`,
    `Active styles: ${n}`,
    "",
    `Give it a first look and build a ProdSpec / make PDFs from spec:`,
    input.comboUrl,
  ].join("\n");

  return { subject, html, text };
}
