import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { CustomerConfigSchema } from "@/lib/customers/config";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  name: z.string().min(1).max(120),
  config: CustomerConfigSchema,
});

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const customers = await db.customer.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ customers });
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

  const customer = await db.customer.upsert({
    where: { slug: parsed.data.slug },
    create: {
      slug: parsed.data.slug,
      name: parsed.data.name,
      config: parsed.data.config as unknown as object,
    },
    update: {
      name: parsed.data.name,
      config: parsed.data.config as unknown as object,
    },
  });

  return NextResponse.json({ customer });
}
