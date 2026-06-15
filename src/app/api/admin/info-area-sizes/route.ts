import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// Admin catalogue of named print sizes (mm) for info-area outputs. Mirrors
// the CareLabel / QrImage CRUD ergonomics: list + create here, edit/delete
// + soft-disable in [id]/route.ts.

const CREATE_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  // Millimetres — fractional allowed (e.g. 27.5). The client normalises a
  // comma decimal to a dot before sending.
  widthMm: z.number().positive().max(1000),
  heightMm: z.number().positive().max(1000),
  active: z.boolean().optional(),
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sizes = await db.infoAreaSize.findMany({
    orderBy: [{ active: "desc" }, { widthMm: "asc" }, { heightMm: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ sizes });
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
  const parsed = CREATE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const size = await db.infoAreaSize.create({
    data: {
      name: parsed.data.name.trim(),
      widthMm: parsed.data.widthMm,
      heightMm: parsed.data.heightMm,
      active: parsed.data.active ?? true,
    },
  });
  return NextResponse.json({ size });
}
