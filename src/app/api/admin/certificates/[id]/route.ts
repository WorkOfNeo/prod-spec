import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateCertificateCache } from "@/lib/pdf/certificates";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  // Accepts raw SVG markup OR a data URL (PNG/JPG/SVG). 1 MB cap.
  logo: z.string().max(1_000_000).nullable().optional(),
  active: z.boolean().optional(),
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

  // Renaming must keep case-insensitive uniqueness, excluding this row.
  if (parsed.data.name !== undefined) {
    const clash = await db.certificate.findFirst({
      where: { name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: id } },
    });
    if (clash) {
      return NextResponse.json({ error: `Certificate "${parsed.data.name}" already exists` }, { status: 409 });
    }
  }

  const updated = await db.certificate.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.logo !== undefined ? { logo: parsed.data.logo } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  });
  invalidateCertificateCache();
  return NextResponse.json({ certificate: updated });
}

// Hard-delete a row. Soft-delete is `PATCH { active: false }` — prefer
// that to keep the name resolvable for styles that still reference it.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  await db.certificate.delete({ where: { id } });
  invalidateCertificateCache();
  return NextResponse.json({ ok: true });
}
