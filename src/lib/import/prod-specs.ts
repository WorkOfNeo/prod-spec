// Detect ProdSpecs that exist but haven't been admin-approved yet —
// `active = false`. These are the auto-created scaffolds left behind by
// Style ingest / Manual Import when a new (Customer × BA) combination
// first lands. The dashboard surfaces them as a "needs configuration"
// notification so they're not invisible.
//
// `active` is the canonical "approved by an operator" flag: ensure.ts
// creates ProdSpecs inactive, the PATCH endpoint auto-activates on any
// non-active field change, and Job auto-enqueue is gated on active=true.

import { db } from "@/lib/db";

export type UnconfiguredProdSpec = {
  id: string;
  customerId: string;
  customerName: string;
  businessAreaId: string;
  businessAreaName: string;
  styleCount: number;
  jobCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function findUnconfiguredProdSpecs(): Promise<UnconfiguredProdSpec[]> {
  const rows = await db.prodSpec.findMany({
    where: { active: false },
    include: {
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
      _count: { select: { styles: true, jobs: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });

  return rows
    .map((p) => ({
      id: p.id,
      customerId: p.customerId,
      customerName: p.customer.name,
      businessAreaId: p.businessAreaId,
      businessAreaName: p.businessArea.name,
      styleCount: p._count.styles,
      jobCount: p._count.jobs,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => {
      // ProdSpecs with attached Styles are the highest priority — real
      // demand is parked there. Then most-recently-updated floats up.
      if (b.styleCount !== a.styleCount) return b.styleCount - a.styleCount;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
}
