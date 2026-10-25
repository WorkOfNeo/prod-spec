import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { devDataLoaderEnabled } from "@/lib/dev-data/flags";
import { listLoadedPos, listRecentPos, loadPos, removePo, runSync, setPoSync } from "@/lib/dev-data/sync";

export const runtime = "nodejs";

// The dev data loader's API (see src/lib/dev-data). Admin-only, and it only
// exists where DEV_DATA_LOADER=true — production 404s.

const BODY_SCHEMA = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load"), pos: z.array(z.string().min(1).max(64)).min(1).max(50) }),
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("toggle"), po: z.string().min(1).max(64), enabled: z.boolean() }),
  z.object({ action: z.literal("remove"), po: z.string().min(1).max(64) }),
]);

export async function GET(req: NextRequest) {
  if (!devDataLoaderEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const search = req.nextUrl.searchParams.get("search") ?? "";
  try {
    const [recent, loaded] = await Promise.all([listRecentPos({ search }), listLoadedPos()]);
    return NextResponse.json({ recent, ...loaded });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!devDataLoaderEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  try {
    const input = parsed.data;
    switch (input.action) {
      case "load":
        return NextResponse.json(await loadPos(input.pos));
      case "sync":
        return NextResponse.json(await runSync());
      case "toggle":
        await setPoSync(input.po, input.enabled);
        return NextResponse.json({ ok: true });
      case "remove":
        await removePo(input.po);
        return NextResponse.json({ ok: true });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
