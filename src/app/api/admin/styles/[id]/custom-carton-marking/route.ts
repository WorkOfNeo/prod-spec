import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { MAX_SIBLING_SLOTS } from "@/lib/output-layouts/token-meta";

export const runtime = "nodejs";

// "Make permanent" for Custom Carton Marking — persist the BEHAVIOUR/SLOTS
// (not specific sibling ids) onto the matching output row of THIS style's
// ProdSpec, so EVERY style on that ProdSpec inherits the multi-style carton
// marking. The actual siblings are still resolved per style/PO at render
// time (applyCustomCartonMarking).
//
//   POST /api/admin/styles/<id>/custom-carton-marking
//   body: { variantKey: "layout:<id>", enabled: boolean, slots?: number }
//
// Writes additively into ProdSpec.outputs JSON (targets one entry by
// variantKey, preserves every other field on it). No schema migration.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  let variantKey = "";
  let enabled = true;
  let slots = 2;
  try {
    const body = (await req.json()) as {
      variantKey?: unknown;
      enabled?: unknown;
      slots?: unknown;
    };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey.split("#")[0];
    if (typeof body?.enabled === "boolean") enabled = body.enabled;
    if (typeof body?.slots === "number") slots = Math.floor(body.slots);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });
  if (enabled && (!Number.isInteger(slots) || slots < 2 || slots > MAX_SIBLING_SLOTS)) {
    return NextResponse.json(
      { error: `slots must be a whole number between 2 and ${MAX_SIBLING_SLOTS}` },
      { status: 400 },
    );
  }

  const style = await db.style.findUnique({
    where: { id },
    select: { prodSpecId: true },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });
  if (!style.prodSpecId) {
    return NextResponse.json(
      { error: "This style has no ProdSpec — can't make a setting permanent. Link a Business Area first." },
      { status: 400 },
    );
  }

  const prodSpec = await db.prodSpec.findUnique({
    where: { id: style.prodSpecId },
    select: { id: true, outputs: true },
  });
  if (!prodSpec) return NextResponse.json({ error: "ProdSpec not found" }, { status: 404 });

  const rawOutputs = Array.isArray(prodSpec.outputs) ? (prodSpec.outputs as unknown[]) : [];
  let matched = false;
  const nextOutputs = rawOutputs.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const row = entry as Record<string, unknown>;
    if (row.variantKey !== variantKey) return entry;
    matched = true;
    return { ...row, customCartonMarking: { enabled, slots } };
  });

  if (!matched) {
    return NextResponse.json(
      { error: `Output "${variantKey}" is not configured on this style's ProdSpec` },
      { status: 404 },
    );
  }

  await db.prodSpec.update({
    where: { id: prodSpec.id },
    data: { outputs: nextOutputs as object[] },
  });

  return NextResponse.json({ ok: true, enabled, slots });
}
