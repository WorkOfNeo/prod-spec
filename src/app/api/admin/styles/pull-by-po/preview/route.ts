import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { previewStylesByPo } from "@/lib/po/pull-by-po";

export const runtime = "nodejs";

// `po` accepts a single PO or a comma/space-separated list of them.
const BODY = z.object({ po: z.string().min(1).max(2000) });

// Preview the styles matching a PO — DB + Monday Pre-Order board, merged. No
// DB writes. ADMIN only (the import it leads to creates/repins styles).
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { po: string }" }, { status: 400 });
  }

  try {
    const { poSeqs, candidates } = await previewStylesByPo(parsed.data.po);
    return NextResponse.json({ poSeqs, candidates });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lookup failed" },
      { status: 502 },
    );
  }
}
