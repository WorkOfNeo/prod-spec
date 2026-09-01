import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { loadTrimConceptRows, saveTrimConceptRows } from "@/lib/trims/catalogue";
import { DEFAULT_PENDING_STATUS, DEFAULT_DELIVERED_STATUS } from "@/lib/trims/concept-copy";

export const runtime = "nodejs";

// The cover page's PACKAGING ROWS — the list a person adds to, and the words
// each row prints. One row is one line on a cover, and the thing both a Monday
// trim label and an Output Builder layout are matched onto.
//
// ADMIN + REVIEWER, matching the cover-page prose and the trim vocabulary it
// sits beside: what a kind of packaging IS, and what a supplier should read
// about it, is reviewer knowledge. Editing renders nothing, arms nothing and
// sends nothing; it changes what the NEXT generated cover says. Existing covers
// keep their words until they are regenerated from the panel next door.
//
//   GET /api/admin/settings/cover-page/packaging-rows        -> { rows, defaults }
//   PUT /api/admin/settings/cover-page/packaging-rows {rows} -> { rows }
//
// A row arriving with no `value` is NEW: the server derives a stable id from
// its label and makes it unique. Clients never mint ids, because a mapping
// stored against a value has to outlive every later edit to the label.

const ROW = z.object({
  // Absent ⇒ a new row. Present ⇒ the row it names, if it exists.
  value: z.string().max(64).optional(),
  label: z.string().min(1).max(120),
  artwork: z.boolean(),
  note: z.string().max(400).optional(),
  // Sent for an artwork:false row too, and dropped server-side rather than
  // trusted-because-hidden: the editor hides these boxes, but the guarantee
  // cannot rest on the editor.
  pending: z.string().max(200).optional(),
  delivered: z.string().max(200).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  // "Removed" in the editor. Rows are deactivated, never deleted — something
  // may still be mapped to one.
  active: z.boolean().optional(),
});

const BODY = z.object({ rows: z.array(ROW).max(200) });

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json({
    rows: await loadTrimConceptRows(),
    // The wording a row inherits when it says nothing of its own, so the editor
    // can show it greyed rather than pretending the box is simply empty.
    defaults: { pending: DEFAULT_PENDING_STATUS, delivered: DEFAULT_DELIVERED_STATUS },
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // saveTrimConceptRows normalises before storing — including STRIPPING the
  // status wording from any packing-instruction row, so a hand-rolled PUT
  // cannot give a polybag a delivery state the cover would then have to print.
  return NextResponse.json({ rows: await saveTrimConceptRows(parsed.data.rows) });
}
