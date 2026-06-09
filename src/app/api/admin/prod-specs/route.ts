import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { backfillStyleProdSpecLinks, ensureProdSpecsForStyle } from "@/lib/prod-spec/ensure";

export const runtime = "nodejs";

// Two accepted shapes:
//   { customerId, businessAreaId }              — single-pair create
//   { customerId, businessAreaIds: string[] }   — batch (one row per pair)
//
// Both go through `ensureProdSpecsForStyle` so manual / wizard / batch
// rows start with identical defaults. After each create we also call
// `backfillStyleProdSpecLinks` to wire any already-ingested Style rows
// to the new ProdSpec — Style ingest only sets prodSpecId at upsert
// time, so post-creation links would otherwise stay null until the
// next sync.
const BODY_SCHEMA = z.union([
  z.object({
    customerId: z.string().min(1),
    businessAreaId: z.string().min(1),
  }),
  z.object({
    customerId: z.string().min(1),
    businessAreaIds: z.array(z.string().min(1)).min(1).max(50),
  }),
]);

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

  const baIds =
    "businessAreaIds" in parsed.data
      ? parsed.data.businessAreaIds
      : [parsed.data.businessAreaId];

  type Created = {
    prodSpec: NonNullable<Awaited<ReturnType<typeof db.prodSpec.findUnique>>>;
    backfilledStyles: number;
  };
  const created: Created[] = [];
  const failed: Array<{ businessAreaId: string; error: string }> = [];

  for (const businessAreaId of baIds) {
    try {
      await ensureProdSpecsForStyle(parsed.data.customerId, businessAreaId);
      const prodSpec = await db.prodSpec.findUnique({
        where: {
          customerId_businessAreaId: {
            customerId: parsed.data.customerId,
            businessAreaId,
          },
        },
      });
      if (!prodSpec) {
        failed.push({ businessAreaId, error: "ProdSpec not found after upsert" });
        continue;
      }
      const backfilledStyles = await backfillStyleProdSpecLinks(
        parsed.data.customerId,
        businessAreaId,
      );
      created.push({ prodSpec, backfilledStyles });
    } catch (err) {
      failed.push({ businessAreaId, error: (err as Error).message });
    }
  }

  // Preserve the legacy `{ prodSpec }` shape when the caller used the
  // single-pair body. Existing manual dialog + wizard depend on it.
  if ("businessAreaId" in parsed.data) {
    const first = created[0];
    if (!first) {
      const f = failed[0];
      return NextResponse.json(
        { error: f?.error ?? "Failed to create ProdSpec" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      prodSpec: first.prodSpec,
      backfilledStyles: first.backfilledStyles,
    });
  }

  return NextResponse.json({
    created: created.map((c) => ({
      prodSpec: c.prodSpec,
      backfilledStyles: c.backfilledStyles,
    })),
    failed,
  });
}
