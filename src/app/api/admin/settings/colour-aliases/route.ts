import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { getColourAliases, setColourAliases } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// Colour aliases — which spellings mean ONE colour, for the per-composition
// care-label split (see splitByComposition in output-layouts/schema.ts).
//
// ADMIN + REVIEWER, matching the trims screen next door: knowing that "LGM" is
// how the buyer writes "Grey melange" is reviewer knowledge, read off Monday
// against the artwork. It arms nothing and sends nothing — the only thing it
// can change is whether a two-quality pack's care label splits per colour, and
// the split itself is a per-layout opt-in.
//
//   GET /api/admin/settings/colour-aliases            -> { groups }
//   PUT /api/admin/settings/colour-aliases { groups } -> { groups } (normalized)

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ groups: await getColourAliases() });
}

const BODY = z.object({
  groups: z.array(z.array(z.string().max(60)).max(12)).max(200),
});

export async function PUT(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { groups: string[][] }" }, { status: 400 });
  }
  // The store normalizes (trims, de-dupes case-insensitively, drops groups left
  // with fewer than two spellings) and returns what was actually saved, so the
  // screen always shows the stored truth rather than what was typed.
  return NextResponse.json({ groups: await setColourAliases(parsed.data.groups) });
}
