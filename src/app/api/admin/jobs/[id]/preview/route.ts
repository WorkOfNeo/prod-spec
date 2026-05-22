import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import type { DocType } from "@/generated/prisma/enums";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const docType = req.nextUrl.searchParams.get("docType") as DocType | null;
  if (!docType) return NextResponse.json({ error: "docType required" }, { status: 400 });

  const asset = await db.jobAsset.findUnique({
    where: { jobId_docType: { jobId: id, docType } },
  });
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
