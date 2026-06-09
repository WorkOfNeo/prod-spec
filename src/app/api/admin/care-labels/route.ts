import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateCareLabelCache, toSymbolCodeArray, toLaunderingAction } from "@/lib/care-labels";
import { STANDARD_CARE_LABELS } from "@/lib/translations/seed";

export const runtime = "nodejs";

const CREATE_SCHEMA = z.object({
  sourceText: z.string().min(1).max(400),
  sortOrder: z.number().int().optional(),
  // Laundering action this line is about — a restrictive symbol of the same
  // action auto-removes it. Coerced against the canonical set (unknown ⇒ null).
  action: z.string().max(32).nullable().optional(),
  // Wash-care symbol codes the line's visibility additionally depends on.
  showIfSymbols: z.array(z.string()).optional(),
  hideIfSymbols: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

const BODY_SCHEMA = z.union([CREATE_SCHEMA, z.object({ seedStandard: z.literal(true) })]);

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const careLabels = await db.careLabel.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ careLabels });
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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

  // Seed the shipped standard lines (idempotent by sourceText). The atomic
  // "wash inside out" + "iron inside out" pair replaces the old compound; the
  // manual show/hide rules start empty and are configured afterwards.
  if ("seedStandard" in parsed.data) {
    let created = 0;
    let repaired = 0;
    for (const seed of STANDARD_CARE_LABELS) {
      const existing = await db.careLabel.findFirst({
        where: { sourceText: { equals: seed.sourceText, mode: "insensitive" } },
      });
      if (existing) {
        // Repair the action tag on an already-seeded line without disturbing
        // its sortOrder / manual rules / active flag.
        await db.careLabel.update({
          where: { id: existing.id },
          data: { action: seed.action },
        });
        repaired++;
        continue;
      }
      await db.careLabel.create({
        data: { sourceText: seed.sourceText, sortOrder: seed.sortOrder, action: seed.action },
      });
      created++;
    }

    // Retire the legacy compound line — superseded by the atomic pair above.
    // Soft-retire (active=false), never delete: keeps it recoverable and any
    // historical references intact (matches the "disable is safer" convention).
    const { count: retired } = await db.careLabel.updateMany({
      where: {
        sourceText: { equals: "wash and iron inside out", mode: "insensitive" },
        active: true,
      },
      data: { active: false },
    });

    invalidateCareLabelCache();
    return NextResponse.json({ seeded: true, created, repaired, retired });
  }

  // Default sortOrder to the end of the list so new lines append.
  const sortOrder =
    parsed.data.sortOrder ??
    ((await db.careLabel.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;

  const careLabel = await db.careLabel.create({
    data: {
      sourceText: parsed.data.sourceText,
      sortOrder,
      action: toLaunderingAction(parsed.data.action),
      showIfSymbols: toSymbolCodeArray(parsed.data.showIfSymbols),
      hideIfSymbols: toSymbolCodeArray(parsed.data.hideIfSymbols),
      active: parsed.data.active ?? true,
    },
  });
  invalidateCareLabelCache();
  return NextResponse.json({ careLabel });
}
