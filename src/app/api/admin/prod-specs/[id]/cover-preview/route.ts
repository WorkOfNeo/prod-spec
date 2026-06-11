import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { renderCoverPageHtml, type BundleDocSummary } from "@/lib/pdf/bundle-pages";

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
    const outputs = parseProdSpecOutputs(prodSpec.outputs).filter((o) => o.enabled !== false);
    const docs: BundleDocSummary[] = outputs.map((o) => {
      const variant = getVariant(o.variantKey);
      return {
        displayName: variant?.name ?? o.variantKey,
        widthMm: o.widthMm,
        heightMm: o.heightMm,
        // Multi-document variants (repeat-per-EAN) only know their file
        // count against a real style — "—" on the sample preview.
        fileCount: variant?.renderMany ? null : 1,
      };
    });

    const sample = buildSampleStyleData();
    const html = renderCoverPageHtml({
      customerName: prodSpec.customer.name,
      businessArea: prodSpec.businessArea.name,
      styleName: sample.styleName,
      styleNumber: sample.styleNumber,
      poNumber: sample.poNumber ?? null,
      supplierName: null,
      generatedAt: new Date(),
      docs,
    });

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
