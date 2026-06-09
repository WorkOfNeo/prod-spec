import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  code: z.string().min(2).max(8).regex(/^[A-Z0-9-]+$/).optional(),
  nameEn: z.string().min(1).max(120).optional(),
  languageCode: z.string().min(2).max(8).regex(/^[a-z-]+$/).optional(),
  nameTranslations: z.record(z.string().min(1), z.string().max(200)).optional(),
  active: z.boolean().optional(),
  mondayValue: z.string().nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // If code is being changed, double-check uniqueness up front so we
  // return a clean error instead of a Prisma constraint failure.
  if (parsed.data.code) {
    const conflict = await db.country.findFirst({
      where: { code: parsed.data.code, NOT: { id } },
    });
    if (conflict) {
      return NextResponse.json(
        { error: `Code "${parsed.data.code}" already used by another row` },
        { status: 409 },
      );
    }
  }

  const country = await db.country.update({
    where: { id },
    data: {
      ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      ...(parsed.data.nameEn !== undefined ? { nameEn: parsed.data.nameEn } : {}),
      ...(parsed.data.languageCode !== undefined ? { languageCode: parsed.data.languageCode } : {}),
      ...(parsed.data.nameTranslations !== undefined
        ? {
            nameTranslations: Object.fromEntries(
              Object.entries(parsed.data.nameTranslations)
                .filter(([, v]) => v.trim().length > 0)
                .map(([k, v]) => [k.toLowerCase(), v]),
            ) as unknown as object,
          }
        : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      ...(parsed.data.mondayValue !== undefined ? { mondayValue: parsed.data.mondayValue } : {}),
    },
  });
  return NextResponse.json({ country });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  // No FK references yet (Country is a lookup namespace, not yet linked
  // from Style/Customer). Safe to hard-delete. When we eventually add a
  // Country FK from Style.countryOfOrigin, this becomes a soft-delete
  // via `active = false` to preserve history.
  await db.country.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
