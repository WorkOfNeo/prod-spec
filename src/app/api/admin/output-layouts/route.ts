import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { defaultLayoutDef, parseLayoutDef } from "@/lib/output-layouts/schema";

export const runtime = "nodejs";

// Output Builder layouts — list + create/duplicate. Admin-only (the
// builder writes print-affecting config).

export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const layouts = await db.outputLayout.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      docType: true,
      status: true,
      version: true,
      definition: true,
      updatedAt: true,
      customer: { select: { id: true, name: true } },
      businessArea: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    layouts: layouts.map((l) => {
      const def = safeDef(l.definition);
      return {
        id: l.id,
        name: l.name,
        docType: l.docType,
        status: l.status,
        version: l.version,
        pageCount: def?.pages.length ?? 0,
        dims: def ? def.pages.map((p) => `${p.widthMm}×${p.heightMm}`).join(", ") : "—",
        customer: l.customer,
        businessArea: l.businessArea,
        updatedAt: l.updatedAt,
      };
    }),
  });
}

function safeDef(raw: unknown) {
  try {
    return parseLayoutDef(raw);
  } catch {
    return null;
  }
}

const CREATE_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  // Duplicate an existing layout instead of starting fresh.
  duplicateFromId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults apply
  }
  const parsed = CREATE_SCHEMA.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.duplicateFromId) {
    const source = await db.outputLayout.findUnique({ where: { id: parsed.data.duplicateFromId } });
    if (!source) return NextResponse.json({ error: "Source layout not found" }, { status: 404 });
    const layout = await db.outputLayout.create({
      data: {
        name: parsed.data.name ?? `${source.name} (copy)`,
        docType: source.docType,
        definition: source.definition as object,
        status: "DRAFT",
        version: 0,
        customerId: source.customerId,
        businessAreaId: source.businessAreaId,
      },
    });
    return NextResponse.json({ layout: { id: layout.id } }, { status: 201 });
  }

  const layout = await db.outputLayout.create({
    data: {
      name: parsed.data.name ?? "Untitled layout",
      docType: "STICKER",
      definition: defaultLayoutDef() as object,
      status: "DRAFT",
      version: 0,
    },
  });
  return NextResponse.json({ layout: { id: layout.id } }, { status: 201 });
}
