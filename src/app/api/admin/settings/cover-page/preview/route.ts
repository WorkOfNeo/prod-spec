import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { DEFAULT_PAGE_SETTINGS } from "@/lib/prod-spec/config";
import { renderCoverPageHtml, type BundleDocSummary } from "@/lib/pdf/bundle-pages";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// A4 preview of the GLOBAL cover block for the /settings/cover-page editor. The
// block is app-wide (no style/spec), so the cover is rendered over SAMPLE
// identity + a couple of representative packaging rows — enough to show the
// block in its real context (below the manifest, on the cover sheet). Read-only;
// the block's <img> serve URLs resolve live in the iframe, so no PDF-style
// inlining is needed here.
//
//   GET /api/admin/settings/cover-page/preview
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const sample = buildSampleStyleData();
  const coverInfoMd = (await getCoverPageInfoMd()).trim();

  // Representative manifest rows — one approved, one pending — so the editor
  // shows the block sitting under a realistic packaging list.
  const docs: BundleDocSummary[] = [
    { displayName: "Care label", widthMm: 40, heightMm: 30, fileCount: 1, approved: true },
    { displayName: "Carton marking", widthMm: 210, heightMm: 148, fileCount: 1, approved: false },
  ];

  const html = renderCoverPageHtml({
    customerName: sample.customerName ?? "Sample customer",
    businessArea: null,
    styleName: sample.styleName,
    styleNumber: sample.styleNumber,
    poNumber: sample.poNumber ?? null,
    supplierName: null,
    generatedAt: new Date(),
    docs,
    settings: DEFAULT_PAGE_SETTINGS,
    coverInfo: coverInfoMd ? { markdown: coverInfoMd } : null,
  });

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The editor saves then refetches — caching would show stale content.
      "Cache-Control": "no-store",
    },
  });
}
