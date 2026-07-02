import { db } from "@/lib/db";
import { dispatchEmail } from "@/lib/email/dispatch";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";

// Nightly supplier-send batch (WS2b). Groups the unsent send-queue by supplier
// → customer and sends ONE digest email per supplier. Replaces the old
// per-approval supplier email. Flag-gated: when supplierBatchSendEnabled is
// OFF this is a DRY RUN — it records what it WOULD send but dispatches nothing
// and stamps nothing, so the queue is untouched. Even when ON, a queue item is
// only marked sent (removed from future batches) once a REAL email leaves
// (outcome SENT); SIMULATED/SKIPPED/FAILED leave it queued to retry.

type QueueItem = {
  id: string;
  styleId: string;
  variantKey: string;
  docType: string;
  displayName: string | null;
  customerId: string;
  supplierId: string | null;
};

export type PerSupplierOutcome = {
  supplierId: string | null;
  supplierName: string;
  email: string | null;
  styleCount: number;
  outputCount: number;
  status: "DRY_RUN" | "NO_EMAIL" | "SENT" | "SIMULATED" | "SKIPPED" | "FAILED";
  emailLogId?: string | null;
  error?: string | null;
};

export type BatchResult = {
  batchId: string;
  status: "EMPTY" | "DRY_RUN" | "SENT" | "PARTIAL" | "FAILED";
  dryRun: boolean;
  supplierCount: number;
  outputCount: number;
  sentCount: number;
  perSupplier: PerSupplierOutcome[];
};

function resolveEmail(s: { email: string | null; contactEmail: string | null } | undefined): string | null {
  if (!s) return null;
  return s.email?.trim() || s.contactEmail?.trim() || null;
}

// Build the digest for one supplier: grouped by customer → style → outputs,
// with the durable portal link + PIN per style. Preview and cron share this.
export function buildSupplierDigest(input: {
  supplierName: string;
  items: QueueItem[];
  styleById: Map<string, { name: string; poNumber: string | null; businessArea: string | null; businessAreaRefName: string | null }>;
  customerById: Map<string, { name: string }>;
  shareByStyle: Map<string, { token: string; pin: string }>;
  baseUrl: string;
}): { subject: string; html: string; text: string } {
  const { supplierName, items, styleById, customerById, shareByStyle, baseUrl } = input;

  // customerId -> styleId -> items
  const byCustomer = new Map<string, Map<string, QueueItem[]>>();
  for (const it of items) {
    const byStyle = byCustomer.get(it.customerId) ?? new Map<string, QueueItem[]>();
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
      const outputs = styleItems.map((i) => i.displayName ?? i.docType).join(", ");
      const poBit = s?.poNumber ? ` · ${s.poNumber}` : "";
      const ba = s?.businessAreaRefName ?? s?.businessArea ?? "";
      htmlParts.push(
        `<p style="margin:6px 0"><strong>${s?.name ?? styleId}</strong>${ba ? ` <span style="color:#888">(${ba})</span>` : ""}${poBit}<br/>` +
          `Outputs: ${outputs}` +
          (portal ? `<br/>Portal: <a href="${portal}">${portal}</a>${share ? ` — PIN ${share.pin}` : ""}` : "") +
          `</p>`,
      );
      textParts.push(
        `- ${s?.name ?? styleId}${ba ? ` (${ba})` : ""}${poBit}\n  Outputs: ${outputs}` +
          (portal ? `\n  Portal: ${portal}${share ? ` — PIN ${share.pin}` : ""}` : ""),
      );
    }
  }
  htmlParts.push(`<p style="color:#888;font-size:12px">Sent by Prod Spec. Files are also in your SharePoint folder.</p>`);
  textParts.push(``, `Sent by Prod Spec. Files are also in your SharePoint folder.`);

  return { subject, html: htmlParts.join("\n"), text: textParts.join("\n") };
}

export async function runSupplierSendBatch(opts?: { source?: "midnight" | "manual" }): Promise<BatchResult> {
  const source = opts?.source ?? "midnight";
  const enabled = await getSupplierBatchSendEnabled();
  const baseUrl = (process.env.PROD_SPEC_BASE_URL ?? "").replace(/\/$/, "");

  const pending = (await db.supplierSendQueueItem.findMany({
    where: { sentAt: null },
    orderBy: { queuedAt: "asc" },
    select: {
      id: true,
      styleId: true,
      variantKey: true,
      docType: true,
      displayName: true,
      customerId: true,
      supplierId: true,
    },
  })) as QueueItem[];

  if (pending.length === 0) {
    const batch = await db.supplierSendBatch.create({
      data: { source, status: "EMPTY", finishedAt: new Date() },
    });
    return { batchId: batch.id, status: "EMPTY", dryRun: !enabled, supplierCount: 0, outputCount: 0, sentCount: 0, perSupplier: [] };
  }

  const styleIds = [...new Set(pending.map((p) => p.styleId))];
  const supplierIds = [...new Set(pending.map((p) => p.supplierId).filter((x): x is string => !!x))];
  const customerIds = [...new Set(pending.map((p) => p.customerId))];

  const [styles, suppliers, customers, shares] = await Promise.all([
    db.style.findMany({
      where: { id: { in: styleIds } },
      select: { id: true, name: true, poNumber: true, businessArea: true, businessAreaRef: { select: { name: true } } },
    }),
    db.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
    db.supplierShare.findMany({ where: { styleId: { in: styleIds } }, select: { styleId: true, token: true, pin: true } }),
  ]);

  const styleById = new Map(
    styles.map((s) => [s.id, { name: s.name, poNumber: s.poNumber, businessArea: s.businessArea, businessAreaRefName: s.businessAreaRef?.name ?? null }]),
  );
  const customerById = new Map(customers.map((c) => [c.id, { name: c.name }]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const shareByStyle = new Map(shares.map((s) => [s.styleId, { token: s.token, pin: s.pin }]));

  // Group by supplier.
  const bySupplier = new Map<string, QueueItem[]>();
  for (const it of pending) {
    const key = it.supplierId ?? "__none__";
    const arr = bySupplier.get(key) ?? [];
    arr.push(it);
    bySupplier.set(key, arr);
  }

  const batch = await db.supplierSendBatch.create({
    data: {
      source,
      status: enabled ? "SENT" : "DRY_RUN",
      supplierCount: bySupplier.size,
      outputCount: pending.length,
    },
  });

  const perSupplier: PerSupplierOutcome[] = [];
  let sentCount = 0;

  for (const [key, items] of bySupplier) {
    const supplier = key === "__none__" ? undefined : supplierById.get(key);
    const supplierName = supplier?.name ?? "— no supplier linked";
    const email = resolveEmail(supplier);
    const styleCount = new Set(items.map((i) => i.styleId)).size;
    const base = { supplierId: supplier?.id ?? null, supplierName, email, styleCount, outputCount: items.length };

    if (!enabled) {
      perSupplier.push({ ...base, status: "DRY_RUN" });
      continue;
    }
    if (!email) {
      perSupplier.push({ ...base, status: "NO_EMAIL", error: "no supplier email on file" });
      continue;
    }

    const digest = buildSupplierDigest({ supplierName, items, styleById, customerById, shareByStyle, baseUrl });
    let outcome;
    try {
      outcome = await dispatchEmail({
        type: "SUPPLIER_APPROVAL",
        to: email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
      });
    } catch (err) {
      perSupplier.push({ ...base, status: "FAILED", error: (err as Error).message });
      continue;
    }

    // Only a REAL send removes items from the queue. SIMULATED/SKIPPED leave
    // them queued so nothing silently "disappears" without reaching anyone.
    if (outcome.status === "SENT") {
      await db.supplierSendQueueItem.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data: { sentAt: new Date(), emailLogId: outcome.emailLogId, batchId: batch.id },
      });
      sentCount += items.length;
      perSupplier.push({ ...base, status: "SENT", emailLogId: outcome.emailLogId });
    } else {
      perSupplier.push({ ...base, status: outcome.status as PerSupplierOutcome["status"], emailLogId: outcome.emailLogId });
    }
  }

  const anySent = perSupplier.some((p) => p.status === "SENT");
  const anyFail = perSupplier.some((p) => p.status === "FAILED" || p.status === "NO_EMAIL");
  const status: BatchResult["status"] = !enabled ? "DRY_RUN" : anySent ? (anyFail ? "PARTIAL" : "SENT") : "FAILED";

  await db.supplierSendBatch.update({
    where: { id: batch.id },
    data: { perSupplier: perSupplier as unknown as object, sentCount, status, finishedAt: new Date() },
  });

  return { batchId: batch.id, status, dryRun: !enabled, supplierCount: bySupplier.size, outputCount: pending.length, sentCount, perSupplier };
}
