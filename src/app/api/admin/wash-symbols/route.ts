import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { sanitizeTranslations } from "@/lib/i18n/translations";
import { invalidateWashcareSymbolCache, STANDARD_WASHCARE_SYMBOLS } from "@/lib/pdf/washcare-symbols";
import { toLaunderingAction } from "@/lib/care-labels/actions";

export const runtime = "nodejs";

const CODE_REGEX = /^[a-z0-9_-]+$/;

const BODY_SCHEMA = z.union([
  z.object({
    code: z.string().min(1).max(64).regex(CODE_REGEX, "code must be lowercase a-z, 0-9, _ or -"),
    name: z.string().min(1).max(120),
    // Field name is legacy — holds either raw SVG markup OR a data URL
    // (PNG/JPG/SVG base64). 1 MB cap covers reasonable PNG uploads;
    // raster-only artwork much bigger than that is print-spec wrong anyway.
    svg: z.string().max(1_000_000).optional().nullable(),
    mondayValue: z.string().max(120).optional().nullable(),
    // Per-language care text. Keys are ISO 639-1 (lang code, lowercase),
    // values are short translations of the symbol's `name`. Empty allowed.
    translations: z.record(z.string().min(1), z.string().max(400)).optional(),
    // Laundering action this symbol concerns + whether it's a prohibition.
    // `action` is coerced against the canonical set (unknown ⇒ null).
    action: z.string().max(32).nullable().optional(),
    restrictive: z.boolean().optional(),
  }),
  z.object({ seedStandard: z.literal(true) }),
]);

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const symbols = await db.washSymbol.findMany({ orderBy: { code: "asc" } });
  return NextResponse.json({ symbols });
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

  // Seed the canonical ISO 3758 / GINETEX codes as placeholder rows.
  // SVGs are uploaded one by one afterwards via PATCH.
  if ("seedStandard" in parsed.data) {
    let created = 0;
    let repaired = 0;
    for (const seed of STANDARD_WASHCARE_SYMBOLS) {
      const existing = await db.washSymbol.findUnique({ where: { code: seed.code } });
      if (existing) {
        // Repair the action classification on an already-seeded row without
        // touching admin-customised name / SVG / translations.
        await db.washSymbol.update({
          where: { code: seed.code },
          data: { action: seed.action, restrictive: seed.restrictive },
        });
        repaired++;
        continue;
      }
      await db.washSymbol.create({
        data: {
          code: seed.code,
          name: seed.name,
          action: seed.action,
          restrictive: seed.restrictive,
          active: true,
        },
      });
      created++;
    }
    invalidateWashcareSymbolCache();
    return NextResponse.json({ seeded: true, created, repaired });
  }

  const existing = await db.washSymbol.findUnique({ where: { code: parsed.data.code } });
  if (existing) {
    return NextResponse.json({ error: `Symbol "${parsed.data.code}" already exists` }, { status: 409 });
  }

  const symbol = await db.washSymbol.create({
    data: {
      code: parsed.data.code,
      name: parsed.data.name,
      svg: parsed.data.svg ?? null,
      mondayValue: parsed.data.mondayValue ?? null,
      translations: sanitizeTranslations(parsed.data.translations),
      action: toLaunderingAction(parsed.data.action),
      restrictive: parsed.data.restrictive ?? false,
      active: true,
    },
  });
  invalidateWashcareSymbolCache();
  return NextResponse.json({ symbol });
}

// Bulk delete — wipes every WashSymbol row. Destructive: any Style whose
// `washSymbols` array references a code that's been deleted will fall back
// to rendering the bare code on labels (the per-row delete behaves the
// same way). Requires a `confirm=all` query param so it can't be triggered
// by an accidental POST → wrong method.
export async function DELETE(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (req.nextUrl.searchParams.get("confirm") !== "all") {
    return NextResponse.json(
      { error: "Refusing bulk delete without ?confirm=all guard" },
      { status: 400 },
    );
  }

  const { count } = await db.washSymbol.deleteMany({});
  invalidateWashcareSymbolCache();
  return NextResponse.json({ deleted: count });
}
