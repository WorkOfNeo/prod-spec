import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { renderPdf } from "@/lib/pdf/renderer";

export const runtime = "nodejs";

// Render a template variant to a real PDF using the shared sample data —
// the "Open PDF" link behind each card on /custom-outputs. This is the
// true output (Puppeteer-rendered, fonts loaded), vs the on-screen HTML
// preview in the grid.
//
//   GET /api/admin/custom-outputs/preview?variantKey=washcare-standard
//
// Sample data is static, so each variant's PDF is rendered once per
// process and cached — repeat opens are instant and we don't pay the
// Puppeteer cost on every click.
const pdfCache = new Map<string, Buffer>();

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const variantKey = req.nextUrl.searchParams.get("variantKey");
  if (!variantKey) {
    return NextResponse.json({ error: "variantKey required" }, { status: 400 });
  }

  const variant = getVariant(variantKey);
  if (!variant) return NextResponse.json({ error: "Unknown variant" }, { status: 404 });

  let pdf = pdfCache.get(variantKey);
  if (!pdf) {
    const sample = buildSampleStyleData();
    const html = await variant.render(sample, {
      widthMm: variant.defaultWidthMm,
      heightMm: variant.defaultHeightMm,
    });
    pdf = await renderPdf({ html });
    pdfCache.set(variantKey, pdf);
  }

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${variant.key}-sample.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
