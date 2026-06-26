import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { renderProdSpecTestBundle, TestBundleError } from "@/lib/pdf/test-bundle";

export const runtime = "nodejs";
// Puppeteer renders can take a few seconds across a handful of outputs —
// keep the function alive well past the default.
export const maxDuration = 120;

// Dry-run the runner for ONE style under this prod spec: render the cover
// (general information rides inside it) + every enabled output to REAL
// PDFs, without creating a job, persisting assets, or notifying reviewers.
// Returns the PDFs base64-encoded so the Test tab can embed each one and
// offer a download — the operator's pre-flight before an actual rerun.
//
//   GET /api/admin/prod-specs/<id>/test-pdf?styleId=<styleId>
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const styleId = req.nextUrl.searchParams.get("styleId");
  if (!styleId) return NextResponse.json({ error: "styleId required" }, { status: 400 });

  try {
    const bundle = await renderProdSpecTestBundle(id, styleId);
    return NextResponse.json(
      {
        style: bundle.style,
        warnings: bundle.warnings,
        docs: bundle.docs.map((d) => ({
          kind: d.kind,
          variantKey: d.variantKey,
          name: d.name,
          fileName: d.fileName,
          widthMm: d.widthMm,
          heightMm: d.heightMm,
          staticPdf: d.staticPdf,
          placeholderCount: d.placeholderCount,
          error: d.error,
          // Base64 PDF bytes — the client rebuilds a Blob URL to embed +
          // download. null when this doc failed to render (see `error`).
          pdfBase64: d.pdf ? d.pdf.toString("base64") : null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // Caller errors (missing/mismatched rows) → 400; anything else → 500.
    if (e instanceof TestBundleError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Test generation failed" },
      { status: 500 },
    );
  }
}
