import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getStyleSubfolderMinPo, setStyleSubfolderMinPo } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ cutoff: await getStyleSubfolderMinPo() });
}

// Set / clear the per-style subfolder cutoff: from this PO on, each style/
// colourway delivers into its own "<style> - <colour>" folder inside APPROVED
// LAYOUTS. ADMIN only. Body: { cutoff: number | null } — null turns it off
// (every PO keeps the flat layout). Forward-only: nothing already delivered
// moves; that's the per-style "Move to style folder" action on /styles/[id].
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cutoff = (body as { cutoff?: unknown })?.cutoff;
  if (cutoff !== null && (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff <= 0)) {
    return NextResponse.json({ error: "Body must be { cutoff: positive number | null }" }, { status: 400 });
  }

  await setStyleSubfolderMinPo(cutoff as number | null);
  await db.log.create({
    data: {
      level: "INFO",
      message: `style-subfolder cutoff ${cutoff === null ? "CLEARED" : `set to PO ≥ ${cutoff}`} by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, cutoff });
}
