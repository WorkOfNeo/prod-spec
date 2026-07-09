import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { countPoFolderFiles } from "@/lib/sharepoint/po-folder-files";

export const runtime = "nodejs";
// A handful of sequential Graph reads (resolve → list folders → count files).
export const maxDuration = 60;

// GET /api/admin/styles/<id>/supplier-folder-files
// → { status, poNumber, folders: [{ name, webUrl, fileCount }], error? }
//
// Live count of the files in this style's PO folder on the supplier's
// SharePoint. Fetched lazily by the Supplier folder panel so the (heavy,
// force-dynamic) style page never blocks on a Graph round-trip.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const style = await db.style.findUnique({
    where: { id },
    select: { poNumber: true, supplier: { select: { sharepointUrl: true } } },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const result = await countPoFolderFiles({
    hasSupplier: style.supplier != null,
    supplierUrl: style.supplier?.sharepointUrl ?? null,
    poNumber: style.poNumber,
  });

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
