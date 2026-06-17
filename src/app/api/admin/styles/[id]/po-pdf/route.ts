import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { findPoPdfDetailed } from "@/lib/po/find-po-pdf";
import { downloadDriveItem } from "@/lib/sharepoint/shares";

export const runtime = "nodejs";
// Locating + downloading the PO PDF from SharePoint can take a few seconds.
export const maxDuration = 60;

// Stream the style's Purchase Order PDF straight from SharePoint so it can be
// previewed in-app (the style page's <iframe>) without anyone visiting
// SharePoint. The fetch runs on app-only Graph credentials, so the viewer
// needs no SharePoint access of their own. Nothing is persisted — this is the
// same locate + download the EAN resolver does, just streamed back as
// application/pdf instead of parsed for barcodes.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const style = await db.style.findUnique({ where: { id }, select: { poNumber: true } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });
  if (!style.poNumber) {
    return NextResponse.json({ error: "No PO number on this style" }, { status: 404 });
  }

  try {
    const { chosen } = await findPoPdfDetailed(style.poNumber);
    if (!chosen) {
      return NextResponse.json({ error: "PO PDF not found in SharePoint" }, { status: 404 });
    }
    const pdf = await downloadDriveItem(chosen);
    if (!pdf) {
      return NextResponse.json({ error: "Could not download PO PDF from SharePoint" }, { status: 502 });
    }
    // Strip quotes/newlines so the filename can't break the header.
    const fileName = chosen.name.replace(/["\r\n]/g, "");
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load PO PDF" },
      { status: 500 },
    );
  }
}
