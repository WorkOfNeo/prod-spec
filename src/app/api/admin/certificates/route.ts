import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateCertificateCache } from "@/lib/pdf/certificates";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  // Holds either raw SVG markup OR a data URL (PNG/JPG/SVG base64). 1 MB
  // cap covers reasonable PNG uploads — same convention as WashSymbol.svg.
  logo: z.string().max(1_000_000).optional().nullable(),
  active: z.boolean().optional(),
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const certificates = await db.certificate.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ certificates });
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

  // Case-insensitive uniqueness — names are matched case-insensitively at
  // render time, so "FSC" and "fsc" must not coexist (they'd collide in
  // the loader's lowercase-keyed map).
  const existing = await db.certificate.findFirst({
    where: { name: { equals: parsed.data.name, mode: "insensitive" } },
  });
  if (existing) {
    return NextResponse.json({ error: `Certificate "${parsed.data.name}" already exists` }, { status: 409 });
  }

  const certificate = await db.certificate.create({
    data: {
      name: parsed.data.name,
      logo: parsed.data.logo ?? null,
      active: parsed.data.active ?? true,
    },
  });
  invalidateCertificateCache();
  return NextResponse.json({ certificate });
}
