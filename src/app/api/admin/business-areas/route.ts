import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// The 7 standard business areas from the original Phase 1 spec.
// Match the BUSINESS_AREAS constant the old manual form used.
const STANDARD_BUSINESS_AREAS: Array<{ mondayValue: string; name: string }> = [
  { mondayValue: "PL", name: "Private Label" },
  { mondayValue: "LICENSE", name: "License" },
  { mondayValue: "BRAND_HOUSE", name: "Brand House" },
  { mondayValue: "LOVED", name: "Loved" },
  { mondayValue: "D2C", name: "D2C" },
  { mondayValue: "SPARK_SHOP", name: "Spark Shop" },
  { mondayValue: "STOCK", name: "Stock" },
];

const BODY_SCHEMA = z.union([
  z.object({
    mondayValue: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
  }),
  z.object({ seedStandard: z.literal(true) }),
]);

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

  // Seed: create rows for the 7 standard areas, skipping any whose
  // mondayValue already exists. Idempotent.
  if ("seedStandard" in parsed.data) {
    let created = 0;
    let skipped = 0;
    for (const seed of STANDARD_BUSINESS_AREAS) {
      const existing = await db.businessArea.findUnique({ where: { mondayValue: seed.mondayValue } });
      if (existing) {
        skipped++;
        continue;
      }
      await db.businessArea.create({
        data: {
          mondayValue: seed.mondayValue,
          name: seed.name,
          active: true,
        },
      });
      created++;
    }
    return NextResponse.json({ seeded: true, created, skipped });
  }

  const existing = await db.businessArea.findUnique({
    where: { mondayValue: parsed.data.mondayValue },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Business area with mondayValue "${parsed.data.mondayValue}" already exists` },
      { status: 409 },
    );
  }

  const ba = await db.businessArea.create({
    data: {
      mondayValue: parsed.data.mondayValue,
      name: parsed.data.name,
      active: true,
    },
  });
  return NextResponse.json({ businessArea: ba });
}
