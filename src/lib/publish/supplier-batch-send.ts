import { db } from "@/lib/db";
import { dispatchEmail } from "@/lib/email/dispatch";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import { combineSupplierRecipients } from "@/lib/suppliers/recipients";
import { loadContactEmailsBySupplier } from "@/lib/suppliers/contact-emails";
import { parseCustomerConfig } from "@/lib/customers/config";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";
import { buildSupplierDigest } from "./supplier-digest";

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
  // Synced supplier-contact emails (plus the legacy contactEmail) CC'd on
  // the digest — resolved via combineSupplierRecipients.
  cc?: string[];
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

// The digest builder lives in the DB-free leaf module supplier-digest.ts so
// tests and the preview route can import it without the Prisma client.
// Re-exported here for callers that still import it from this module.
export { buildSupplierDigest } from "./supplier-digest";

export async function runSupplierSendBatch(opts?: { source?: "midnight" | "manual" }): Promise<BatchResult> {
  const source = opts?.source ?? "midnight";
  const enabled = await getSupplierBatchSendEnabled();
  const baseUrl = (process.env.PROD_SPEC_BASE_URL ?? "").replace(/\/$/, "");

  let pending = (await db.supplierSendQueueItem.findMany({
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

  // Send-time guard for the per-style operator ignore. The ignore endpoint
  // already deletes unsent rows, so this only catches items that slipped in
  // between (a re-approval race, or an enqueue path predating the ignore) —
  // drop them from the queue so they neither send tonight nor linger as
  // forever-pending on /settings/approved.
  const ignoredByStyle = await loadIgnoredOutputKeysByStyle([
    ...new Set(pending.map((p) => p.styleId)),
  ]);
  const ignoredItems = pending.filter((p) => ignoredByStyle.get(p.styleId)?.has(p.variantKey));
  if (ignoredItems.length > 0) {
    await db.supplierSendQueueItem.deleteMany({
      where: { id: { in: ignoredItems.map((i) => i.id) } },
    });
    console.warn(
      `[supplier-batch-send] dropped ${ignoredItems.length} queued item(s) whose output is ignored for the style`,
    );
    pending = pending.filter((p) => !ignoredByStyle.get(p.styleId)?.has(p.variantKey));
  }

  // Customers who deliver their own goods (config.skipSupplierDelivery) must
  // never reach a supplier digest. publishApprovedJob skips their delivery,
  // but the enqueue paths predate that gate — drop any of their rows here,
  // exactly like the ignored-output guard above.
  if (pending.length > 0) {
    const configs = await db.customer.findMany({
      where: { id: { in: [...new Set(pending.map((p) => p.customerId))] } },
      select: { id: true, config: true },
    });
    const skipDeliveryCustomers = new Set(
      configs.filter((c) => parseCustomerConfig(c.config).skipSupplierDelivery).map((c) => c.id),
    );
    const skipDeliveryItems = pending.filter((p) => skipDeliveryCustomers.has(p.customerId));
    if (skipDeliveryItems.length > 0) {
      await db.supplierSendQueueItem.deleteMany({
        where: { id: { in: skipDeliveryItems.map((i) => i.id) } },
      });
      console.warn(
        `[supplier-batch-send] dropped ${skipDeliveryItems.length} queued item(s) for skip-delivery customers`,
      );
      pending = pending.filter((p) => !skipDeliveryCustomers.has(p.customerId));
    }
  }

  if (pending.length === 0) {
    const batch = await db.supplierSendBatch.create({
      data: { source, status: "EMPTY", finishedAt: new Date() },
    });
    return { batchId: batch.id, status: "EMPTY", dryRun: !enabled, supplierCount: 0, outputCount: 0, sentCount: 0, perSupplier: [] };
  }

  // Make the digest's "files are in your SharePoint folder" line true before
  // any email leaves: push every still-pending upload into the suppliers' own
  // folders (retries FAILED/SKIPPED rows from approve-time pushes; flag-gated
  // + fail-soft inside the lib). The email still goes out if a folder push
  // fails — the portal link always works — and the row stays visible as
  // FAILED on /settings/approved.
  if (enabled) {
    const swept = await pushQueuedSupplierUploads({
      styleIds: [...new Set(pending.map((p) => p.styleId))],
      // Midnight retries even rows that used up their day-time strikes.
      includeFloated: true,
    });
    if (swept.styles > 0) {
      console.log(
        `[supplier-batch-send] supplier-folder sweep: ${swept.uploaded} uploaded, ${swept.failed} failed, ${swept.skipped} skipped across ${swept.styles} style(s)`,
      );
    }
  }

  const styleIds = [...new Set(pending.map((p) => p.styleId))];
  const supplierIds = [...new Set(pending.map((p) => p.supplierId).filter((x): x is string => !!x))];
  const customerIds = [...new Set(pending.map((p) => p.customerId))];

  const [styles, suppliers, customers, shares] = await Promise.all([
    db.style.findMany({
      where: { id: { in: styleIds } },
      select: { id: true, name: true, poNumber: true, businessArea: true, supplierFolderUrl: true, businessAreaRef: { select: { name: true } } },
    }),
    db.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true, email: true, contactEmail: true },
    }),
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
    db.supplierShare.findMany({ where: { styleId: { in: styleIds } }, select: { styleId: true, token: true, pin: true } }),
  ]);

  const styleById = new Map(
    styles.map((s) => [
      s.id,
      {
        name: s.name,
        poNumber: s.poNumber,
        businessArea: s.businessArea,
        businessAreaRefName: s.businessAreaRef?.name ?? null,
        supplierFolderUrl: s.supplierFolderUrl,
      },
    ]),
  );
  const customerById = new Map(customers.map((c) => [c.id, { name: c.name }]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const shareByStyle = new Map(shares.map((s) => [s.styleId, { token: s.token, pin: s.pin }]));
  // Synced supplier-contact emails (Supplier Contacts board) — the digest
  // goes To the company inbox (or the first contact when none) and CCs the
  // remaining contacts.
  const contactEmailsBySupplier = await loadContactEmailsBySupplier(supplierIds);

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
    const { to: email, cc } = combineSupplierRecipients(
      supplier,
      supplier ? (contactEmailsBySupplier.get(supplier.id) ?? []) : [],
    );
    const styleCount = new Set(items.map((i) => i.styleId)).size;
    const base = { supplierId: supplier?.id ?? null, supplierName, email, cc, styleCount, outputCount: items.length };

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
        cc: cc.length > 0 ? cc : undefined,
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
