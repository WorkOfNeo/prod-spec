import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  name: z.string().min(1).max(120),
  // Required — a QR entry with no image is meaningless. Holds a data URL
  // (PNG/JPG/SVG base64) or raw SVG markup. 1 MB cap.
  image: z.string().min(1).max(1_000_000),
  active: z.boolean().optional(),
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const qrImages = await db.qrImage.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
  return NextResponse.json({ qrImages });
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

  const qrImage = await db.qrImage.create({
    data: {
      name: parsed.data.name,
      image: parsed.data.image,
      active: parsed.data.active ?? true,
    },
  });
  return NextResponse.json({ qrImage });
}
