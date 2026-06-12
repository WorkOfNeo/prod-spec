import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { deriveDocTypeValue } from "@/lib/pdf/doc-types";
import { loadDocTypesWithUsage } from "@/lib/pdf/doc-types-db";
import { TEMPLATE_VARIANTS } from "@/lib/pdf/template-registry";

export const runtime = "nodejs";

// =====================================================
// Doc-type catalogue management (Custom outputs → Document types card).
// GET returns the catalogue with usage counts (drives the delete guard
// in the UI); POST adds a type. Label edits / deletes live in
// ./[value]/route.ts.
// =====================================================

export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const types = await loadDocTypesWithUsage(new Set(TEMPLATE_VARIANTS.map((v) => v.docType)));
  return NextResponse.json({ types });
}

const POST_SCHEMA = z.object({
  label: z.string().min(2).max(60),
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
  const parsed = POST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const label = parsed.data.label.trim();
  const value = deriveDocTypeValue(label);
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(value)) {
    return NextResponse.json({ error: "Name must contain at least one letter or digit" }, { status: 400 });
  }
  // COVER / GENERAL_INFO are runner-internal framing pages, not pickable.
  if (value === "COVER" || value === "GENERAL_INFO") {
    return NextResponse.json({ error: `"${value}" is reserved for the bundle framing pages` }, { status: 409 });
  }

  try {
    const max = await db.docTypeDef.aggregate({ _max: { sortOrder: true } });
    const row = await db.docTypeDef.create({
      data: { value, label, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    return NextResponse.json({ type: { value: row.value, label: row.label } }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      return NextResponse.json({ error: `A type with the value ${value} already exists` }, { status: 409 });
    }
    if (code === "P2021") {
      return NextResponse.json(
        { error: "doc_types table missing — apply the pending migration (npm run db:deploy)" },
        { status: 503 },
      );
    }
    throw err;
  }
}
