// GET /api/admin/import/notifications
//
// Backs the sidebar bell's popover. Returns one row per actionable
// thing: a new (customer × BA) combination, or a group of ghost items
// ready to import for a specific (customer × BA) pair.
//
// Cheap-ish — runs the same scanForImport() the dashboard uses, then
// reduces. Called only when the operator clicks the bell, so the 60s
// counts poll stays a constant tiny query.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { scanForImport } from "@/lib/import/scan";
import { findUnconfiguredProdSpecs } from "@/lib/import/prod-specs";

export const runtime = "nodejs";

type NotificationRow =
  | {
      kind: "new_combination";
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      matchCount: number;
      ambiguousCount: number;
    }
  | {
      kind: "ready_to_import";
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      count: number;
    }
  | {
      kind: "needs_config";
      prodSpecId: string;
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      styleCount: number;
    };

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [scan, unconfigured] = await Promise.all([
    scanForImport(),
    findUnconfiguredProdSpecs(),
  ]);

  // Aggregate importable items by (customer × BA) — operators don't want
  // 200 separate "JYSK A/S × Apparel" notifications, they want one row
  // that says "12 items ready to import" and links into the dashboard.
  const importableGroups = new Map<
    string,
    {
      customerId: string;
      customerName: string;
      businessAreaId: string;
      businessAreaName: string;
      count: number;
    }
  >();
  for (const it of scan.importable) {
    if (it.customerResolution.kind !== "unique") continue;
    if (it.baResolution.kind !== "resolved") continue;
    const key = `${it.customerResolution.customerId}::${it.baResolution.businessAreaId}`;
    let acc = importableGroups.get(key);
    if (!acc) {
      acc = {
        customerId: it.customerResolution.customerId,
        customerName: it.customerResolution.customerName,
        businessAreaId: it.baResolution.businessAreaId,
        businessAreaName: it.baResolution.baName,
        count: 0,
      };
      importableGroups.set(key, acc);
    }
    acc.count++;
  }

  const notifications: NotificationRow[] = [
    ...scan.newCombinations.map<NotificationRow>((c) => ({
      kind: "new_combination",
      customerId: c.customerId,
      customerName: c.customerName,
      businessAreaId: c.businessAreaId,
      businessAreaName: c.businessAreaName,
      matchCount: c.matchCount,
      ambiguousCount: c.ambiguousCount,
    })),
    // "needs config" sits above the per-pair Ready rows because each
    // one represents a (customer × BA) that's blocking real document
    // generation on its already-ingested Styles.
    ...unconfigured.map<NotificationRow>((p) => ({
      kind: "needs_config",
      prodSpecId: p.id,
      customerId: p.customerId,
      customerName: p.customerName,
      businessAreaId: p.businessAreaId,
      businessAreaName: p.businessAreaName,
      styleCount: p.styleCount,
    })),
    ...Array.from(importableGroups.values())
      .sort((a, b) => b.count - a.count)
      .map<NotificationRow>((g) => ({
        kind: "ready_to_import",
        customerId: g.customerId,
        customerName: g.customerName,
        businessAreaId: g.businessAreaId,
        businessAreaName: g.businessAreaName,
        count: g.count,
      })),
  ];

  return NextResponse.json({
    notifications,
    totals: {
      newCombinations: scan.newCombinations.length,
      importable: scan.importable.length,
      ambiguous: scan.ambiguous.length,
      needsConfig: unconfigured.length,
    },
  });
}
