import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { buildSupplierDigest } from "@/lib/publish/supplier-batch-send";

export const runtime = "nodejs";

// Preview the nightly digest for one supplier — the exact email that would go
// out at midnight, built from the unsent queue with the shared buildSupplierDigest
// (so preview == what sends). Read-only; sends nothing. ?supplierId=<id> or
// ?supplierId=none for the "no supplier linked" group.
export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const supplierIdParam = req.nextUrl.searchParams.get("supplierId");
  const noSupplier = supplierIdParam === "none" || supplierIdParam === null;

  const items = await db.supplierSendQueueItem.findMany({
    where: { sentAt: null, supplierId: noSupplier ? null : supplierIdParam },
    orderBy: { queuedAt: "asc" },
    select: {
      id: true,
      styleId: true,
      variantKey: true,
      docType: true,
      displayName: true,
      customerId: true,
      supplierId: true,
    },
  });

  if (items.length === 0) {
    return NextResponse.json({ empty: true, to: null, subject: null, html: null, text: null });
  }

  const styleIds = [...new Set(items.map((i) => i.styleId))];
  const customerIds = [...new Set(items.map((i) => i.customerId))];

  const [styles, customers, shares, supplier] = await Promise.all([
    db.style.findMany({
      where: { id: { in: styleIds } },
      select: { id: true, name: true, poNumber: true, businessArea: true, businessAreaRef: { select: { name: true } } },
    }),
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
    db.supplierShare.findMany({ where: { styleId: { in: styleIds } }, select: { styleId: true, token: true, pin: true } }),
    noSupplier
      ? Promise.resolve(null)
      : db.supplier.findUnique({
          where: { id: supplierIdParam! },
          select: { name: true, email: true, contactEmail: true },
        }),
  ]);

  const styleById = new Map(
    styles.map((s) => [
      s.id,
      { name: s.name, poNumber: s.poNumber, businessArea: s.businessArea, businessAreaRefName: s.businessAreaRef?.name ?? null },
    ]),
  );
  const customerById = new Map(customers.map((c) => [c.id, { name: c.name }]));
  const shareByStyle = new Map(shares.map((s) => [s.styleId, { token: s.token, pin: s.pin }]));
  const baseUrl = (process.env.PROD_SPEC_BASE_URL ?? "").replace(/\/$/, "");
  const to = supplier?.email?.trim() || supplier?.contactEmail?.trim() || null;

  const digest = buildSupplierDigest({
    supplierName: supplier?.name ?? "— no supplier linked",
    items,
    styleById,
    customerById,
    shareByStyle,
    baseUrl,
  });

  return NextResponse.json({ empty: false, to, subject: digest.subject, html: digest.html, text: digest.text });
}
