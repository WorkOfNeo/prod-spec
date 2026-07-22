import { db } from "@/lib/db";
import { buildStyleData } from "@/lib/styles/render-context";
import { parseCustomerConfig } from "@/lib/customers/config";
import { parseBundlePageSettings } from "@/lib/prod-spec/config";
import { buildRequiredPackagingForStyle } from "@/lib/outputs/required-packaging";
import { renderStyleCoverPdf } from "@/lib/pdf/cover";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";

// Rebuild a style's cover PDF from scratch, off the job id, with a caller-
// supplied set of currently-approved output bases. Used by publish to refresh
// the delivered cover so it reflects the approval state the supplier is
// receiving (the generation-time cover was baked while everything was still
// pending review). Mirrors the runner's cover build — same identity resolution
// (buildStyleData → styleNumber), same page settings, same general-info-inside-
// the-cover layout — so the refreshed cover is byte-for-byte the runner's
// modulo the approval flags and generated-at timestamp.
//
// Returns null when the job/style can't be loaded; the caller keeps the
// generation-time cover in that case.
export async function buildStyleCoverPdf(
  jobId: string,
  approvedBaseKeys: ReadonlySet<string>,
): Promise<Buffer | null> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      style: {
        select: {
          id: true,
          name: true,
          rawData: true,
          poNumber: true,
          cartonEan: true,
          mondayBoardId: true,
          businessArea: true,
          businessAreaRef: { select: { name: true } },
          customer: { select: { name: true, config: true } },
          supplier: { select: { name: true, country: true } },
          eans: {
            orderBy: { position: "asc" },
            select: { size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true },
          },
          qrImage: { select: { image: true } },
          prodSpec: {
            select: {
              id: true,
              logoSvg: true,
              careInstructionsByLang: true,
              outputLanguages: true,
              columnMapping: true,
              outputs: true,
              bundlePageSettings: true,
              generalInfoMd: true,
            },
          },
        },
      },
    },
  });
  if (!job) return null;

  const style = job.style;
  const prodSpec = style.prodSpec;
  const config = parseCustomerConfig(style.customer.config);

  const styleData = await buildStyleData(
    {
      id: style.id,
      rawData: style.rawData,
      poNumber: style.poNumber,
      cartonEan: style.cartonEan,
      mondayBoardId: style.mondayBoardId,
      supplier: style.supplier ? { country: style.supplier.country } : null,
      eans: style.eans,
      customer: { name: style.customer.name, config: style.customer.config },
      qrImage: style.qrImage ? { image: style.qrImage.image } : null,
    },
    prodSpec,
    config,
  );

  // Assets are persisted by publish time, so the required-packaging state is
  // read live — except the approval flags, which the caller projects to the
  // post-publish set (this job's about-to-be-approved outputs aren't APPROVED
  // in the DB yet at the moment we render).
  const docs = await buildRequiredPackagingForStyle(style.id, {
    approvedBaseKeysOverride: approvedBaseKeys,
  });

  const pageSettings = parseBundlePageSettings(prodSpec?.bundlePageSettings);
  const generalInfoMd = prodSpec?.generalInfoMd?.trim();
  const coverInfoMd = (await getCoverPageInfoMd().catch(() => "")).trim();
  const businessAreaName = style.businessAreaRef?.name ?? style.businessArea ?? null;

  return renderStyleCoverPdf(
    {
      customerName: style.customer.name,
      businessArea: businessAreaName,
      styleName: style.name,
      styleNumber: styleData.styleNumber,
      poNumber: style.poNumber ?? null,
      supplierName: style.supplier?.name ?? null,
      generatedAt: new Date(),
      docs,
      settings: pageSettings.cover,
      generalInfo: generalInfoMd
        ? { markdown: generalInfoMd, settings: pageSettings.generalInfo }
        : null,
      coverInfo: coverInfoMd ? { markdown: coverInfoMd } : null,
    },
    prodSpec?.id ?? null,
  );
}
