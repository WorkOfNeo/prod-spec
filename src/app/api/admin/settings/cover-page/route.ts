import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getCoverPageInfoMd, setCoverPageInfoMd } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// The GLOBAL cover-page content block — markdown printed on the cover sheet of
// every bundle, edited at /settings/cover-page. ADMIN + REVIEWER: the block is
// the supplier-facing standing text (e.g. "the pictogram is handed over by the
// supplier"), which is reviewer knowledge, not configuration — so reviewers
// maintain it themselves rather than queueing a request to an admin. It touches
// no config: the only thing it can change is words on the cover sheet.
//
//   GET   /api/admin/settings/cover-page        → { markdown }
//   PATCH /api/admin/settings/cover-page { markdown }

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ markdown: await getCoverPageInfoMd() });
}

const BODY_SCHEMA = z.object({ markdown: z.string().max(100_000) });

export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
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
      { error: parsed.error.issues[0]?.message ?? "Body must be { markdown: string }" },
      { status: 400 },
    );
  }

  await setCoverPageInfoMd(parsed.data.markdown);
  const markdown = await getCoverPageInfoMd();
  await db.log.create({
    data: {
      level: "INFO",
      message: `global cover-page content ${markdown ? "updated" : "cleared"} by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, markdown });
}
