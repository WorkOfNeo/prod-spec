import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateWashcareSymbolCache } from "@/lib/pdf/washcare-symbols";
import { sanitizeTranslations } from "@/lib/i18n/translations";
import { toLaunderingAction } from "@/lib/care-labels/actions";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  // `code` is intentionally immutable — it's referenced by Style.washSymbols
  // and (eventually) by Monday ingest mapping. Rename a row by adding a
  // new one and deactivating the old.
  name: z.string().min(1).max(120).optional(),
  // Accepts raw SVG markup OR a data URL (PNG/JPG/SVG). 1 MB cap.
  svg: z.string().max(1_000_000).nullable().optional(),
  mondayValue: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
  translations: z.record(z.string().min(1), z.string().max(400)).optional(),
  // Laundering action + prohibition flag. `action` coerced against the
  // canonical set (unknown ⇒ null); only written when present in the body.
  action: z.string().max(32).nullable().optional(),
  restrictive: z.boolean().optional(),
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
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await db.washSymbol.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.svg !== undefined ? { svg: parsed.data.svg } : {}),
      ...(parsed.data.mondayValue !== undefined ? { mondayValue: parsed.data.mondayValue } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      ...(parsed.data.translations !== undefined
        ? { translations: sanitizeTranslations(parsed.data.translations) }
        : {}),
      ...(parsed.data.action !== undefined
        ? { action: toLaunderingAction(parsed.data.action) }
        : {}),
      ...(parsed.data.restrictive !== undefined ? { restrictive: parsed.data.restrictive } : {}),
    },
  });
  invalidateWashcareSymbolCache();
  return NextResponse.json({ symbol: updated });
}

// Hard-delete a row. Soft-delete is `PATCH { active: false }` — prefer
// that when you want to keep historical references intact. Hard delete
// is only safe when no Style has the code in its washSymbols list.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  await db.washSymbol.delete({ where: { id } });
  invalidateWashcareSymbolCache();
  return NextResponse.json({ ok: true });
}
