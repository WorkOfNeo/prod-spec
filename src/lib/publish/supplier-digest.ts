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

// Build the digest for one supplier: grouped by customer → style → outputs.
// Per style the primary link is the supplier's OWN SharePoint folder
// (Style.supplierFolderUrl — the files are already uploaded there by the
// recurring sweep before any email leaves); the portal link + PIN is the
// fallback for styles whose folder push hasn't succeeded yet, so the supplier
// always has SOME way in.
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

  const htmlParts: string[] = [`<p>Hi ${supplierName},</p>`, `<p>The following approved production specs are ready for you:</p>`];
  const textParts: string[] = [`Hi ${supplierName},`, ``, `The following approved production specs are ready for you:`, ``];

  for (const [customerId, byStyle] of byCustomer) {
    const cName = customerById.get(customerId)?.name ?? "—";
    htmlParts.push(`<h3 style="margin:16px 0 4px">${cName}</h3>`);
    textParts.push(`== ${cName} ==`);
    for (const [styleId, styleItems] of byStyle) {
      const s = styleById.get(styleId);
      const share = shareByStyle.get(styleId);
      const portal = share ? `${baseUrl}/s/${share.token}` : null;
      const folder = s?.supplierFolderUrl ?? null;
      const outputs = styleItems.map((i) => i.displayName ?? i.docType).join(", ");
      const poBit = s?.poNumber ? ` · ${s.poNumber}` : "";
      const ba = s?.businessAreaRefName ?? s?.businessArea ?? "";
      // SharePoint folder first (files already there); portal + PIN only as
      // the fallback when no folder push has succeeded for this style yet.
      const htmlLink = folder
        ? `<br/>SharePoint folder: <a href="${folder}">${folder}</a>`
        : portal
          ? `<br/>Portal: <a href="${portal}">${portal}</a>${share ? ` — PIN ${share.pin}` : ""}`
          : "";
      const textLink = folder
        ? `\n  SharePoint folder: ${folder}`
        : portal
          ? `\n  Portal: ${portal}${share ? ` — PIN ${share.pin}` : ""}`
          : "";
      htmlParts.push(
        `<p style="margin:6px 0"><strong>${s?.name ?? styleId}</strong>${ba ? ` <span style="color:#888">(${ba})</span>` : ""}${poBit}<br/>` +
          `Outputs: ${outputs}` +
          htmlLink +
          `</p>`,
      );
      textParts.push(`- ${s?.name ?? styleId}${ba ? ` (${ba})` : ""}${poBit}\n  Outputs: ${outputs}` + textLink);
    }
  }
  htmlParts.push(`<p style="color:#888;font-size:12px">Sent by Prod Spec. The files are in your SharePoint folder — the links above take you straight there.</p>`);
  textParts.push(``, `Sent by Prod Spec. The files are in your SharePoint folder — the links above take you straight there.`);

  return { subject, html: htmlParts.join("\n"), text: textParts.join("\n") };
}
