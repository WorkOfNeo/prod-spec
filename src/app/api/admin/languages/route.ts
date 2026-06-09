import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { STANDARD_LANGUAGES } from "@/lib/languages/seed";

export const runtime = "nodejs";

// BCP 47-friendly regex: lowercase language part, optional uppercase
// region or script part. Accepts "en", "de-AT", "zh-Hans", "nl-BE".
const CODE_REGEX = /^[a-z]{2,3}(-[A-Z][a-z]{0,3}|-[A-Z]{2})?$/;

const BODY_SCHEMA = z.union([
  z.object({
    code: z.string().min(2).max(10).regex(CODE_REGEX, "expected BCP 47 / ISO 639-1 (e.g. en, de-AT)"),
    name: z.string().min(1).max(120),
    nativeName: z.string().max(120).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }),
  z.object({ seedStandard: z.literal(true) }),
]);

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rows = await db.language.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return NextResponse.json({ languages: rows });
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

  // Idempotent seed — skips codes that already exist (admins are free to
  // rename / disable seeded rows without re-seeding overwriting them).
  if ("seedStandard" in parsed.data) {
    let created = 0;
    let skipped = 0;
    for (const seed of STANDARD_LANGUAGES) {
      const existing = await db.language.findUnique({ where: { code: seed.code } });
      if (existing) {
        skipped++;
        continue;
      }
      await db.language.create({
        data: {
          code: seed.code,
          name: seed.name,
          nativeName: seed.nativeName,
          sortOrder: seed.sortOrder,
          active: true,
        },
      });
      created++;
    }
    return NextResponse.json({ seeded: true, created, skipped });
  }

  const existing = await db.language.findUnique({ where: { code: parsed.data.code } });
  if (existing) {
    return NextResponse.json(
      { error: `Language with code "${parsed.data.code}" already exists` },
      { status: 409 },
    );
  }

  const language = await db.language.create({
    data: {
      code: parsed.data.code,
      name: parsed.data.name,
      nativeName: parsed.data.nativeName ?? null,
      sortOrder: parsed.data.sortOrder ?? 999,
      active: true,
    },
  });
  return NextResponse.json({ language });
}
