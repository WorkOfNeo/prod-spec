import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { pullStylesByPo, unpullStyle, listPulledStyles } from "@/lib/po/pull-by-po";

export const runtime = "nodejs";
// Each pulled item re-fetches + re-ingests from Monday; a handful per call.
export const maxDuration = 60;

const POST_BODY = z.object({
  mondayItemIds: z.array(z.string().min(1)).min(1).max(200),
});

const DELETE_BODY = z.object({ styleId: z.string().min(1) });

// GET — the current pulled-for-test set, for the Settings management list.
export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ pulled: await listPulledStyles() });
}

// POST — pull the selected Monday Pre-Order items onto the styleboard (refresh +
// ingest + pin). Returns a per-item breakdown so the UI can surface skips
// (needs disambiguation) and errors without failing the whole batch.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = POST_BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { mondayItemIds: string[] }", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await pullStylesByPo(parsed.data.mondayItemIds);
  await db.log.create({
    data: {
      level: "INFO",
      message:
        `pull-by-PO: ${result.pulled.length} pulled, ${result.skipped.length} skipped, ` +
        `${result.errors.length} errored by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, ...result });
}

// DELETE — un-pull a style (clear the pin; it returns to normal visibility).
export async function DELETE(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = DELETE_BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { styleId: string }" }, { status: 400 });
  }

  const cleared = await unpullStyle(parsed.data.styleId);
  return NextResponse.json({ ok: true, cleared });
}
