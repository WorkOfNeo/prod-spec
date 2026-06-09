import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { normaliseTranslationKey } from "@/lib/translations/lookup";

export const runtime = "nodejs";

// GET /api/admin/translations/lookup?text=<english phrase>
// Resolves an English phrase to its dictionary entry — the same normalised
// key the renderer uses — so editors (e.g. the care-label dialog) can show
// the full source line plus every per-language translation inline. Returns
// { found: false } for an empty or unknown phrase rather than a 404, so the
// caller can render a neutral "no translation yet" state.
export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const key = normaliseTranslationKey(req.nextUrl.searchParams.get("text") ?? "");
  if (!key) return NextResponse.json({ found: false });

  const row = await db.translation.findUnique({
    where: { key },
    select: {
      sourceText: true,
      translations: true,
      category: true,
      lastSyncedAt: true,
    },
  });
  if (!row) return NextResponse.json({ found: false });

  return NextResponse.json({
    found: true,
    sourceText: row.sourceText,
    translations: (row.translations ?? {}) as Record<string, string>,
    category: row.category,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  });
}
