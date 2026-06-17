import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getAutomationMinPo, setAutomationMinPo } from "@/lib/settings/app-settings";
import { parsePoNumberValue } from "@/lib/po/po-number";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ cutoff: await getAutomationMinPo() });
}

// Set / clear the automation PO cutoff — "scrape + generate from this PO
// onward". Accepts whatever the operator pastes ("C-PO63144", "63144"); empty
// string clears it (no cutoff → whole backlog). ADMIN only — it changes how
// much of the backlog automation touches.
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = (body as { cutoff?: unknown })?.cutoff;
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "Body must be { cutoff: string }" }, { status: 400 });
  }

  const trimmed = raw.trim();
  const cutoff = trimmed === "" ? null : parsePoNumberValue(trimmed);
  if (trimmed !== "" && cutoff === null) {
    return NextResponse.json(
      { error: "Could not read a PO number from that — paste e.g. C-PO63144" },
      { status: 400 },
    );
  }

  await setAutomationMinPo(cutoff);
  await db.log.create({
    data: {
      level: "INFO",
      message:
        cutoff === null
          ? `automation PO cutoff CLEARED by user ${auth.userId} — automation processes the whole backlog`
          : `automation PO cutoff set to ${cutoff} by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, cutoff });
}
