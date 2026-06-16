import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { refreshLayoutVariants } from "@/lib/output-layouts/variants";
import { detachLayoutsFromProdSpecs } from "@/lib/output-layouts/detach";

export const runtime = "nodejs";

const BODY = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

// Bulk-delete Output Builder layouts (multi-select on the list). Deletes
// the rows, then cleanly drops each deleted layout from any Prod Spec that
// referenced it (layout:<id> entries) — same model as the single delete.
// Generated PDFs (JobAsset rows) hang off Jobs, not layouts, so they're kept.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const ids = [...new Set(parsed.data.ids)];

  // Resolve which ids actually exist + whether any were PUBLISHED (so we
  // know to refresh the in-memory variant registry after deleting).
  const existing = await db.outputLayout.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  if (existing.length === 0) {
    return NextResponse.json({ error: "No matching layouts" }, { status: 404 });
  }

  const existingIds = existing.map((l) => l.id);
  const { count } = await db.outputLayout.deleteMany({ where: { id: { in: existingIds } } });
  const { specsUpdated } = await detachLayoutsFromProdSpecs(existingIds);
  if (existing.some((l) => l.status === "PUBLISHED")) await refreshLayoutVariants();

  return NextResponse.json({ ok: true, deleted: count, specsUpdated });
}
