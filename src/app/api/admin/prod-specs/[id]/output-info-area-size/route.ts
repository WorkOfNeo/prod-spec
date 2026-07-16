import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";

export const runtime = "nodejs";

// Set the per-style info-area size for ONE output of a ProdSpec, from the
// Style page's output card OR the review screen's output card. The pick
// lives on ProdSpec.outputs[] (shared by every style under this spec — no
// per-style column), so this updates that one output entry in place.
//
//   PATCH /api/admin/prod-specs/<id>/output-info-area-size
//   body: { variantKey, infoAreaSizeId: string | null, widthMm?, heightMm? }
//
//   • infoAreaSizeId set  → use that admin size; its dimensions are
//     snapshotted into widthMm/heightMm (server-authoritative, ignores any
//     client dims) as a fallback for when the size is later deactivated.
//   • infoAreaSizeId null → "custom": clear the pick and store the supplied
//     widthMm/heightMm as the one-time custom size.
//
// Deliberately does NOT auto-activate the ProdSpec (unlike the full editor
// PATCH) — switching a print size is a render tweak, not spec approval.
const BODY_SCHEMA = z.object({
  variantKey: z.string().min(1),
  infoAreaSizeId: z.string().min(1).nullable(),
  // Fractional mm allowed (e.g. 27.5) for a one-time custom size.
  widthMm: z.number().positive().max(1000).optional(),
  heightMm: z.number().positive().max(1000).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Reviewers included: the review screen is where sizes are actually picked
  // (reviewers rarely open the style page). Switching a print size is a
  // render tweak followed by a re-run — the same trust level as the scoped
  // re-run / carton customize actions, which are already canReview.
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { variantKey, infoAreaSizeId } = parsed.data;

  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { outputs: true } });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const outputs = parseProdSpecOutputs(prodSpec.outputs);
  const target = outputs.find((o) => o.variantKey === variantKey);
  if (!target) {
    return NextResponse.json({ error: "Output not configured on this ProdSpec" }, { status: 404 });
  }

  if (infoAreaSizeId) {
    // Admin size — resolve its dimensions server-side and snapshot them.
    const size = await db.infoAreaSize.findUnique({
      where: { id: infoAreaSizeId },
      select: { widthMm: true, heightMm: true },
    });
    if (!size) return NextResponse.json({ error: "Unknown info area size" }, { status: 400 });
    target.infoAreaSizeId = infoAreaSizeId;
    target.widthMm = size.widthMm;
    target.heightMm = size.heightMm;
  } else {
    // Custom — clear the pick and store the supplied dims (fall back to the
    // existing dims when none supplied, so a no-op "switch to custom" keeps
    // the current size).
    target.infoAreaSizeId = null;
    if (parsed.data.widthMm !== undefined) target.widthMm = parsed.data.widthMm;
    if (parsed.data.heightMm !== undefined) target.heightMm = parsed.data.heightMm;
  }

  await db.prodSpec.update({ where: { id }, data: { outputs: outputs as unknown as object } });
  return NextResponse.json({
    ok: true,
    output: {
      variantKey,
      infoAreaSizeId: target.infoAreaSizeId ?? null,
      widthMm: target.widthMm,
      heightMm: target.heightMm,
    },
  });
}
