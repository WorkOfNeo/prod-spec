import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// Download a single generated PDF under its stored fileName — the same
// bytes the preview endpoint streams inline, but with an attachment
// disposition so the browser saves "sty-10427-care-label-02.pdf" instead
// of opening a viewer tab.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const asset = await db.jobAsset.findUnique({
    where: { id },
    select: { fileName: true, pdf: true },
  });
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(asset.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeFileName(asset.fileName)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

// fileNames are slugged ASCII by construction (see runner.ts), but a
// header value must never carry quotes/control chars regardless.
function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_");
}
