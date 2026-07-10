// Leaf module — the pure digest builder, DB-free so tests (and the preview
// route) can import it without pulling the Prisma client in. The batch sender
// (supplier-batch-send.ts) and /api/admin/supplier-send/preview share it, so
// preview == what sends.

export type DigestQueueItem = {
  id: string;
  styleId: string;
  variantKey: string;
  docType: string;
  displayName: string | null;
  customerId: string;
  supplierId: string | null;
};

export type DigestStyle = {
  name: string;
  poNumber: string | null;
  businessArea: string | null;
  businessAreaRefName: string | null;
  supplierFolderUrl?: string | null;
};

// Self-contained HTML escaper. This module stays DB-free (and dependency-free)
// so the preview route + tests can import it cheaply, so we don't reach for the
// PDF template's escaper — a four-replace inline copy is all the digest needs.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Email-safe palette (shared with the review-notification house style: dark
// #18181b ink, zinc greys, a hairline border) — all literal hex, since email
// clients don't do CSS variables.
const INK = "#18181b";
const MUTE = "#71717a";
const FAINT = "#a1a1aa";
const LINE = "#e4e4e7";
const PAGE_BG = "#f4f4f5";

// The dark pill CTA reused for both the SharePoint-folder and portal links.
const BTN = `display:inline-block;margin-top:12px;background:${INK};color:#ffffff;font-size:13px;font-weight:600;padding:9px 16px;border-radius:7px;text-decoration:none`;

// Build the digest for one supplier: grouped by customer → style → outputs.
// Per style the primary link is the supplier's OWN SharePoint folder
// (Style.supplierFolderUrl — the files are already uploaded there by the
// recurring sweep before any email leaves); the portal link + PIN is the
// fallback for styles whose folder push hasn't succeeded yet, so the supplier
// always has SOME way in.
//
// The HTML is a table-based, all-inline-styles layout so it survives Gmail and
// Outlook; the plain-text arm is the fallback for clients that strip HTML.
export function buildSupplierDigest(input: {
  supplierName: string;
  items: DigestQueueItem[];
  styleById: Map<string, DigestStyle>;
  customerById: Map<string, { name: string }>;
  shareByStyle: Map<string, { token: string; pin: string }>;
  baseUrl: string;
}): { subject: string; html: string; text: string } {
  const { supplierName, items, styleById, customerById, shareByStyle, baseUrl } = input;

  // customerId -> styleId -> items
  const byCustomer = new Map<string, Map<string, DigestQueueItem[]>>();
  for (const it of items) {
    const byStyle = byCustomer.get(it.customerId) ?? new Map<string, DigestQueueItem[]>();
    const arr = byStyle.get(it.styleId) ?? [];
    arr.push(it);
    byStyle.set(it.styleId, arr);
    byCustomer.set(it.customerId, byStyle);
  }

  const styleCount = new Set(items.map((i) => i.styleId)).size;
  const customerNames = [...byCustomer.keys()].map((cid) => customerById.get(cid)?.name ?? "—");
  const subject = `Approved production specs — ${styleCount} style${styleCount === 1 ? "" : "s"} ready (${customerNames.join(", ")})`;

  // ---- HTML body (carded) + plain-text arm, built in one pass. ----
  // The per-customer sections accumulate here; the wrapper (header / greeting /
  // footer) is assembled once at the end.
  const sectionsHtml: string[] = [];
  const textParts: string[] = [`Hi ${supplierName},`, ``, `The following approved production specs are ready for you:`, ``];

  for (const [customerId, byStyle] of byCustomer) {
    const cName = customerById.get(customerId)?.name ?? "—";
    textParts.push(`== ${cName} ==`);

    const cards: string[] = [];
    for (const [styleId, styleItems] of byStyle) {
      const s = styleById.get(styleId);
      const share = shareByStyle.get(styleId);
      const portal = share ? `${baseUrl}/s/${share.token}` : null;
      const folder = s?.supplierFolderUrl ?? null;
      const outputs = styleItems.map((i) => i.displayName ?? i.docType).join(", ");
      const poBit = s?.poNumber ? ` · ${s.poNumber}` : "";
      const ba = s?.businessAreaRefName ?? s?.businessArea ?? "";
      const name = s?.name ?? styleId;

      // SharePoint folder first (files already there); portal + PIN only as
      // the fallback when no folder push has succeeded for this style yet.
      const cta = folder
        ? `<a href="${esc(folder)}" style="${BTN}">Open SharePoint folder &rarr;</a>`
        : portal
          ? `<a href="${esc(portal)}" style="${BTN}">Open portal &rarr;</a>` +
            (share ? `<span style="margin-left:10px;font-size:12px;color:${MUTE}">PIN <strong style="color:${INK};letter-spacing:1px">${esc(share.pin)}</strong></span>` : "")
          : `<div style="margin-top:10px;font-size:12px;color:${FAINT}">Link to follow.</div>`;
      const textLink = folder
        ? `\n  SharePoint folder: ${folder}`
        : portal
          ? `\n  Portal: ${portal}${share ? ` — PIN ${share.pin}` : ""}`
          : "";

      const poHtml = s?.poNumber
        ? `<div style="margin-top:2px"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:${FAINT}">${esc(s.poNumber)}</span></div>`
        : "";
      const baHtml = ba ? `<span style="margin-left:8px;font-size:12px;font-weight:500;color:${MUTE}">${esc(ba)}</span>` : "";

      cards.push(
        `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border:1px solid ${LINE};border-radius:10px">` +
          `<tr><td style="padding:14px 16px">` +
          `<div style="font-size:15px;font-weight:600;color:${INK}">${esc(name)}${baHtml}</div>` +
          poHtml +
          `<div style="margin-top:8px;font-size:13px;color:#52525b"><span style="color:${FAINT}">Outputs:</span> ${esc(outputs)}</div>` +
          cta +
          `</td></tr></table>`,
      );

      textParts.push(`- ${name}${ba ? ` (${ba})` : ""}${poBit}\n  Outputs: ${outputs}` + textLink);
    }

    sectionsHtml.push(
      `<div style="padding:18px 0 6px"><span style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${FAINT}">${esc(cName)}</span></div>` +
        cards.join("\n"),
    );
  }

  textParts.push(``, `Sent by Prod Spec. The files are in your SharePoint folder — the links above take you straight there.`);

  const headline = `${styleCount} approved production spec${styleCount === 1 ? "" : "s"} ready`;
  const html =
    `<div style="margin:0;padding:24px 12px;background:${PAGE_BG};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">` +
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden">` +
    // Header
    `<tr><td style="padding:22px 28px 18px;border-bottom:1px solid ${LINE}">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${FAINT}">Prod Spec</div>` +
    `<div style="margin-top:6px;font-size:19px;font-weight:600;color:${INK}">${headline}</div>` +
    `</td></tr>` +
    // Body
    `<tr><td style="padding:22px 28px 26px">` +
    `<p style="margin:0 0 4px;font-size:14px;color:${INK}">Hi ${esc(supplierName)},</p>` +
    `<p style="margin:0;font-size:14px;color:#52525b">The approved production specs below are ready for you. The files are already in your SharePoint folder &mdash; use the links to jump straight in.</p>` +
    sectionsHtml.join("\n") +
    `</td></tr>` +
    // Footer
    `<tr><td style="padding:16px 28px 22px;border-top:1px solid ${LINE}">` +
    `<div style="font-size:12px;color:${FAINT}">Sent by Prod Spec on behalf of Contrast. Reply to this email if anything looks off.</div>` +
    `</td></tr>` +
    `</table></td></tr></table></div>`;

  return { subject, html, text: textParts.join("\n") };
}
