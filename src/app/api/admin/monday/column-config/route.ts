import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getColumnConfig, setColumnConfig, GlobalColumnConfigSchema } from "@/lib/monday/column-config";

export const runtime = "nodejs";

// Shared Monday column mapping (global, all customers). ADMIN only.
export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const config = await getColumnConfig();
  return NextResponse.json({ config });
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = GlobalColumnConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid config", details: parsed.error.flatten() }, { status: 400 });
  }

  const config = await setColumnConfig(parsed.data);
  return NextResponse.json({ config });
}
