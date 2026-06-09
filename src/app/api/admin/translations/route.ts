import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { STANDARD_TRANSLATIONS } from "@/lib/translations/seed";
import { normaliseTranslationKey } from "@/lib/translations/lookup";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({ seedStandard: z.literal(true) });

// POST /api/admin/translations  { seedStandard: true }
// Upserts the shipped STANDARD_TRANSLATIONS (e.g. the fixed care-label
// instruction). Idempotent and merge-safe: existing board-synced languages
// are preserved, the seed fills/overwrites the languages it ships.
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

  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const seed of STANDARD_TRANSLATIONS) {
    const key = normaliseTranslationKey(seed.sourceText);
    const existing = await db.translation.findUnique({ where: { key } });
    const mergedTranslations = {
      ...((existing?.translations as Record<string, string> | undefined) ?? {}),
      ...seed.translations,
    };
    await db.translation.upsert({
      where: { key },
      create: {
        key,
        sourceText: seed.sourceText,
        translations: mergedTranslations as object,
        category: seed.category,
        active: true,
        lastSyncedAt: now,
      },
      update: {
        sourceText: seed.sourceText,
        translations: mergedTranslations as object,
        category: existing?.category ?? seed.category,
        active: true,
      },
    });
    if (existing) updated++;
    else created++;
  }
  return NextResponse.json({ seeded: true, created, updated });
}
