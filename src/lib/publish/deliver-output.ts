import { db } from "@/lib/db";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import { supplierOutputEmail } from "@/lib/email/templates/review-notification";
import { getSupplierReviewCcEmails } from "@/lib/settings/app-settings";
import { isSharepointConfigured } from "@/lib/publish/publish-approved-job";
import { uploadJobAssets } from "@/lib/sharepoint/upload";
import { getFile } from "@/lib/sharepoint/client";
import { upsertShareForStyle } from "@/lib/supplier-share/share";
import { perOutputDeliveryEnabled } from "@/lib/review-flow/flags";

// =====================================================
// Per-output supplier delivery (per-output refactor, phase 3).
//
// Deliver ONE approved output to the supplier: upload that file (when
// SharePoint is configured), ensure the per-style share link, send a
// per-output email, and record an OutputDelivery so a re-run doesn't
// re-notify. This replaces the job-level "publish everything" path when
// per-output delivery is enabled.
//
// GATED OFF by perOutputDeliveryEnabled() (PER_OUTPUT_DELIVERY_ENABLED) — it
// returns null immediately when off, so it never touches the output_deliveries
// table before that table is deployed. Even when ON, every send goes through
// dispatchEmail(), so the email kill switch still blocks real delivery during
// the test phase (the email is staged + viewable, deliveredAt stays null).
// =====================================================
export async function deliverOutput(jobAssetId: string): Promise<EmailOutcome | null> {
  if (!perOutputDeliveryEnabled()) return null;

  const asset = await db.jobAsset.findUnique({
    where: { id: jobAssetId },
    include: {
      job: {
        include: {
          style: { include: { customer: true, supplier: true, businessAreaRef: true } },
        },
      },
    },
  });
  if (!asset || asset.reviewStatus !== "APPROVED") return null;
  const style = asset.job.style;
  const variantBase = (asset.variantKey ?? `doc:${asset.docType}`).split("#")[0];

  // Upload just this one asset (best-effort; publish continues without it).
  const sharepointConfigured = isSharepointConfigured();
  const supplierSlug = style.supplier ? slugify(style.supplier.name) : null;
  const folderPath = [
    "prodspec",
    style.customer.slug,
    ...(supplierSlug ? [supplierSlug] : []),
    style.mondayItemId,
  ].join("/");
  const uploaded = sharepointConfigured
    ? await uploadJobAssets({
        folderPath,
        assets: [{ fileName: asset.fileName, docType: asset.docType, pdf: Buffer.from(asset.pdf) }],
      })
    : [];
  let folderUrl: string | null = null;
  if (sharepointConfigured) {
    try {
      folderUrl = (await getFile(folderPath))?.webUrl ?? null;
    } catch {
      folderUrl = null;
    }
  }

  const supplier = style.supplier;
  const supplierEmail = supplier?.email?.trim() || process.env.SUPPLIER_NOTIFICATION_EMAIL || null;
  const reviewCc = await getSupplierReviewCcEmails();
  const ccList = Array.from(
    new Set([...reviewCc, supplier?.contactEmail ?? ""].map((e) => e.trim()).filter(Boolean)),
  );
  const share = await upsertShareForStyle({ styleId: style.id, email: supplierEmail ?? "" });

  const email = supplierOutputEmail({
    outputName: asset.displayName ?? asset.docType,
    styleName: style.name,
    styleNumber: style.mondayItemId,
    customerName: style.customer.name,
    businessArea: style.businessAreaRef?.name ?? style.businessArea ?? null,
    poNumber: style.poNumber,
    file: { name: asset.fileName, webUrl: uploaded[0]?.webUrl ?? null },
    shareUrl: share.url,
    sharePin: share.pin,
    folderUrl,
  });
  const outcome = await dispatchEmail({
    type: "SUPPLIER_APPROVAL",
    to: supplierEmail ?? "",
    cc: ccList.length > 0 ? ccList : undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments: [{ filename: asset.fileName, content: Buffer.from(asset.pdf) }],
    jobId: asset.jobId,
    styleId: style.id,
  });

  // Record the delivery thread. deliveredAt is set only on a real SEND — while
  // the kill switch is on (test phase) it stays null, so re-runs keep staging.
  await db.outputDelivery.upsert({
    where: { styleId_variantKey: { styleId: style.id, variantKey: variantBase } },
    create: {
      styleId: style.id,
      variantKey: variantBase,
      jobAssetId: asset.id,
      emailLogId: outcome.emailLogId,
      deliveredAt: outcome.status === "SENT" ? new Date() : null,
    },
    update: {
      jobAssetId: asset.id,
      emailLogId: outcome.emailLogId,
      deliveredAt: outcome.status === "SENT" ? new Date() : null,
    },
  });

  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message: `per-output delivery for ${variantBase} → supplier email ${outcome.status} (To: ${outcome.to || "(none)"})`,
    },
  });

  return outcome;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}
