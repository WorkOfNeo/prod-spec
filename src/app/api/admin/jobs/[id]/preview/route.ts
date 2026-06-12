import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// Preview a single rendered PDF.
// Two query shapes supported, both kept for back-compat:
//   ?variantKey=washcare-standard   (preferred — uniquely identifies one asset)
//   ?docType=WASHCARE               (legacy — picks the first asset of that docType
//                                    on the job, which is fine when there's only
//                                    one variant per docType on a ProdSpec)
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const variantKey = req.nextUrl.searchParams.get("variantKey");
  const docType = req.nextUrl.searchParams.get("docType");

  if (!variantKey && !docType) {
    return NextResponse.json({ error: "variantKey or docType required" }, { status: 400 });
  }

  const asset = variantKey
    ? await db.jobAsset.findFirst({ where: { jobId: id, variantKey } })
    : await db.jobAsset.findFirst({ where: { jobId: id, docType: docType! } });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(asset.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
