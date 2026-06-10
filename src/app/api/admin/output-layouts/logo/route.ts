import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { setCustomLogoDataUrl } from "@/lib/output-layouts/logos";

export const runtime = "nodejs";

// Global custom logo for {{logo:custom}} — one per installation, stored
// as a data URL in the AppSetting store. POST sets it, DELETE clears it.
// (The CONTRAST logo is a repo file — public/logos/contrast.svg — not
// managed here.)

const BODY_SCHEMA = z.object({
  // SVG / PNG / JPEG data URL, capped at ~600 KB of encoded payload so a
  // stray photo doesn't bloat every render.
  dataUrl: z
    .string()
    .regex(/^data:image\/(svg\+xml|png|jpeg);base64,/, "must be an SVG, PNG or JPEG data URL")
    .max(600_000, "logo too large — keep it under ~450 KB"),
});

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
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  await setCustomLogoDataUrl(parsed.data.dataUrl);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await setCustomLogoDataUrl(null);
  return NextResponse.json({ ok: true });
}
