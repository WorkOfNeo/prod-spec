import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import { parseProdSpecOutputs, parseProdSpecLanguages } from "@/lib/prod-spec/config";
import { parseCareInstructions } from "@/lib/styles/render-context";

export const runtime = "nodejs";

// Per-output preview for the ProdSpec EDITOR: sample style data + THIS
// prod spec's configuration (logo, output languages, care-instruction
// override, per-output dims and pins). Unlike /custom-outputs (pure
// catalogue defaults), this shows what the spec's configuration does to
// the output while tuning it — before any real style exists.
//
//   GET /api/admin/prod-specs/<id>/output-preview?variantKey=care-label-02
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const variantKey = req.nextUrl.searchParams.get("variantKey");
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  const variant = getVariant(variantKey);
  if (!variant) return NextResponse.json({ error: "Unknown variant" }, { status: 404 });

  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    include: { customer: { select: { name: true } } },
  });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const outputs = parseProdSpecOutputs(prodSpec.outputs);
  const output = outputs.find((o) => o.variantKey === variantKey);
  const dims = output
    ? { widthMm: output.widthMm, heightMm: output.heightMm }
    : { widthMm: variant.defaultWidthMm, heightMm: variant.defaultHeightMm };

  if (variant.staticPdf) {
    return NextResponse.json(
      {
        staticPdf: true,
        message: "Static artwork passthrough — the output is the committed source PDF.",
      },
      { status: 409 },
    );
  }

  try {
    // Sample data, but wearing THIS prod spec's configuration. The sample
    // logo is replaced by the spec's logo (or none — honest about an
    // unconfigured header), and languages / care override / pins apply
    // exactly as the runner would apply them.
    const sample = buildSampleStyleData();
    sample.customerName = prodSpec.customer.name;
    sample.prodSpecLogoSvg = prodSpec.logoSvg ?? null;
    sample.outputLanguages = parseProdSpecLanguages(prodSpec.outputLanguages);
    sample.careInstructionsByLang = parseCareInstructions(prodSpec.careInstructionsByLang);
    const renderStyle = applyFieldOverrides(sample, output?.fieldOverrides);

    const html = await variant.render(renderStyle, dims);
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
