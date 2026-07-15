import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { parseBundlePageSettings, parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { renderCoverPageHtml, type BundleDocSummary } from "@/lib/pdf/bundle-pages";
import { inlineProdSpecImages } from "@/lib/pdf/inline-images";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// A4 cover-page preview for the ProdSpec editor's General information tab:
// THIS spec's enabled outputs (title + mm dims, once each) wearing sample
// style identity. Read-only — the cover follows the Outputs tab; the runner
// renders the real one per job from the final generated-document list.
//
//   GET /api/admin/prod-specs/<id>/cover-preview
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Output Builder layouts register under `layout:<id>` keys — load them
  // so those outputs preview with their proper names, not raw keys.
  await ensureLayoutVariantsLoaded();

  const { id } = await ctx.params;
  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
    },
  });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  try {
    const sizeMap = await loadInfoAreaSizeMap();
    const outputs = parseProdSpecOutputs(prodSpec.outputs).filter((o) => o.enabled !== false);
    const docs: BundleDocSummary[] = outputs.map((o) => {
      const variant = getVariant(o.variantKey);
      // Same size resolution as the runner (info-area picks honoured) so the
      // preview matches the generated cover. No approval status here — this is a
      // config preview with no style; the real per-job cover flags approved vs
      // "Awaiting Contrast confirmation" from live review state.
      const dims = effectiveOutputDims(o, variant?.isInfoArea ?? false, sizeMap);
      return {
        displayName: variant?.name ?? o.variantKey,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        // Multi-document variants (repeat-per-EAN) only know their file
        // count against a real style — "—" on the sample preview.
        fileCount: variant?.renderMany ? null : 1,
      };
    });

    const sample = buildSampleStyleData();
    const pageSettings = parseBundlePageSettings(prodSpec.bundlePageSettings);
    const generalInfoMd = prodSpec.generalInfoMd?.trim();
    // The global cover block ships on every cover — show it in the per-spec
    // preview too. Its <img> serve URLs resolve live in the iframe (same-origin,
    // admin session), so no inlining is needed here (unlike the PDF path).
    const coverInfoMd = (await getCoverPageInfoMd().catch(() => "")).trim();
    let html = renderCoverPageHtml({
      customerName: prodSpec.customer.name,
      businessArea: prodSpec.businessArea.name,
      styleName: sample.styleName,
      styleNumber: sample.styleNumber,
      poNumber: sample.poNumber ?? null,
      supplierName: null,
      generatedAt: new Date(),
      docs,
      settings: pageSettings.cover,
      // Mirror the runner: the general-info pages ship inside the cover
      // document, so the preview shows the full document.
      generalInfo: generalInfoMd
        ? { markdown: generalInfoMd, settings: pageSettings.generalInfo }
        : null,
      coverInfo: coverInfoMd ? { markdown: coverInfoMd } : null,
    });
    // Inline any general-info image URLs to data URLs — same as the runner.
    if (generalInfoMd) html = await inlineProdSpecImages(html, id);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The editor autosaves and refetches — caching would show stale config.
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}
