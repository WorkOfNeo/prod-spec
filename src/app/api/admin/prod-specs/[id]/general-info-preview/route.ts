import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { renderGeneralInfoHtml } from "@/lib/pdf/bundle-pages";
import { parseBundlePageSettings } from "@/lib/prod-spec/config";

export const runtime = "nodejs";

// A4 preview of the "General information" page — ProdSpec.generalInfoMd
// rendered through the SAME function the runner uses, so the editor
// preview is the print truth. Empty markdown renders a friendly hint
// instead of erroring: the preview iframe can race an autosave.
//
//   GET /api/admin/prod-specs/<id>/general-info-preview
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
    },
  });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const markdown = (prodSpec.generalInfoMd ?? "").trim();

  try {
    const html = markdown
      ? renderGeneralInfoHtml({
          markdown,
          customerName: prodSpec.customer.name,
          businessArea: prodSpec.businessArea.name,
          settings: parseBundlePageSettings(prodSpec.bundlePageSettings).generalInfo,
        })
      : emptyStateHtml();

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The editor autosaves and refetches — caching would show stale text.
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

function emptyStateHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  body {
    width: 210mm; min-height: 297mm; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, Helvetica, sans-serif; color: #a1a1aa;
  }
  p { max-width: 120mm; text-align: center; font-size: 11pt; line-height: 1.6; }
</style></head>
<body><p>No general information yet — write markdown in the editor and this page
joins every generated bundle. Headings, lists and tables all render.</p></body>
</html>`;
}
