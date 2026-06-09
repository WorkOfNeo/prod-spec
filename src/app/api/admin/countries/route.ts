import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { STANDARD_COUNTRIES } from "@/lib/countries/seed";

export const runtime = "nodejs";

const BODY_SCHEMA = z.union([
  z.object({
    code: z.string().min(2).max(8).regex(/^[A-Z0-9-]+$/, "code must be uppercase letters/digits"),
    nameEn: z.string().min(1).max(120),
    languageCode: z.string().min(2).max(8).regex(/^[a-z-]+$/, "language code must be lowercase"),
    nameTranslations: z.record(z.string().min(1), z.string().max(200)).optional(),
    mondayValue: z.string().nullable().optional(),
  }),
  z.object({ seedStandard: z.literal(true) }),
]);

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rows = await db.country.findMany({ orderBy: { nameEn: "asc" } });
  return NextResponse.json({ countries: rows });
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
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Seed standard set: idempotent. Existing rows are left alone — admin
  // edits aren't overwritten by re-seeding.
  if ("seedStandard" in parsed.data) {
    let created = 0;
    let skipped = 0;
    for (const seed of STANDARD_COUNTRIES) {
      const existing = await db.country.findUnique({ where: { code: seed.code } });
      if (existing) {
        skipped++;
        continue;
      }
      await db.country.create({
        data: {
          code: seed.code,
          nameEn: seed.nameEn,
          languageCode: seed.languageCode,
          nameTranslations: seed.nameTranslations as unknown as object,
          active: true,
        },
      });
      created++;
    }
    return NextResponse.json({ seeded: true, created, skipped });
  }

  const existing = await db.country.findUnique({ where: { code: parsed.data.code } });
  if (existing) {
    return NextResponse.json(
      { error: `Country with code "${parsed.data.code}" already exists` },
      { status: 409 },
    );
  }

  const country = await db.country.create({
    data: {
      code: parsed.data.code,
      nameEn: parsed.data.nameEn,
      languageCode: parsed.data.languageCode,
      nameTranslations: (parsed.data.nameTranslations ?? {}) as unknown as object,
      mondayValue: parsed.data.mondayValue ?? null,
      active: true,
    },
  });
  return NextResponse.json({ country });
}
