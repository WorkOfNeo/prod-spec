import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { getStoredTrimConceptCopy, setTrimConceptCopy } from "@/lib/settings/app-settings";
import { DEFAULT_TRIM_CONCEPT_COPY } from "@/lib/trims/concept-copy";
import { DEFAULT_TRIM_CONCEPTS } from "@/lib/trims/concepts";

export const runtime = "nodejs";

// What a cover says about each trim concept — the standing note and the
// not-delivered / delivered status wording.
//
// ADMIN + REVIEWER, matching the cover-page prose and the trim vocabulary it
// sits beside: this is supplier-facing wording, which is reviewer knowledge.
// Editing it renders nothing, arms nothing and sends nothing; it changes what
// the NEXT generated cover says. Existing covers keep their words until they
// are regenerated from the panel next door.
//
//   GET /api/admin/settings/cover-page/trim-copy      -> { concepts, defaults, copy }
//   PUT /api/admin/settings/cover-page/trim-copy {copy} -> { copy }
//
// `copy` in both directions is the OVERRIDE layer only, so the editor can show
// an inherited default as a placeholder rather than as something typed. An
// empty string is a real value meaning "cleared, use the house default" — which
// is why the fields are not `.min(1)`.

const ENTRY = z.object({
  note: z.string().max(400).optional(),
  pending: z.string().max(200).optional(),
  delivered: z.string().max(200).optional(),
});

const BODY = z.object({
  copy: z.record(z.string().min(1).max(64), ENTRY),
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json({
    concepts: DEFAULT_TRIM_CONCEPTS,
    defaults: DEFAULT_TRIM_CONCEPT_COPY,
    copy: await getStoredTrimConceptCopy(),
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

  // setTrimConceptCopy normalises before storing — including STRIPPING the
  // status wording from any packing-instruction concept, so a hand-rolled PUT
  // cannot give a polybag a delivery state the cover would then have to print.
  await setTrimConceptCopy(parsed.data.copy);
  return NextResponse.json({ copy: await getStoredTrimConceptCopy() });
}
