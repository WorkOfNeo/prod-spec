import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getStylesTableColumns, setStylesTableColumns } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ visible: await getStylesTableColumns() });
}

// Set which columns the /styles table shows — the GLOBAL standard view for
// every user, not a per-user preference. ADMIN only. Unknown keys are
// dropped and locked columns forced on (see normalizeVisibleColumns), so
// the echoed `visible` is the canonical, normalized list.
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const visible = (body as { visible?: unknown })?.visible;
  if (!Array.isArray(visible) || !visible.every((v) => typeof v === "string")) {
    return NextResponse.json({ error: "Body must be { visible: string[] }" }, { status: 400 });
  }

  await setStylesTableColumns(visible);
  const normalized = await getStylesTableColumns();
  await db.log.create({
    data: {
      level: "INFO",
      message: `styles table columns set to [${normalized.join(", ")}] by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, visible: normalized });
}
