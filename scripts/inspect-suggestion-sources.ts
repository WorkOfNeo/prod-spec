// Inspect what's available to seed prod-spec suggestions:
//   1) existing Customer × BusinessArea pairs in current ProdSpec rows
//   2) Style rows (currently empty per the parked ingest)
//   3) ghost Styles items — what's in __business_area__1 and what
//      customer names appear at the start of item names

import { db } from "@/lib/db";

async function main() {
  const customers = await db.customer.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const businessAreas = await db.businessArea.findMany({
    where: { active: true },
    select: { id: true, name: true, mondayValue: true },
    orderBy: { name: "asc" },
  });
  const prodSpecs = await db.prodSpec.findMany({
    select: { customerId: true, businessAreaId: true },
  });
  const styles = await db.style.count();

  console.log(`Customers active: ${customers.length}`);
  console.log(`BusinessAreas active: ${businessAreas.length}`);
  console.log(`ProdSpecs: ${prodSpecs.length}`);
  console.log(`Styles (domain): ${styles}`);

  // BA distribution in ghost styles items
  const stylesBoard = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: "6979419195" },
  });
  if (!stylesBoard) return;

  const baCounts = await db.$queryRaw<Array<{ ba: string; c: bigint }>>`
    SELECT cv->>'text' as ba, count(*)::bigint as c
    FROM monday_ghost_items i, jsonb_array_elements(i."columnValues") cv
    WHERE i."boardId" = ${stylesBoard.id}
      AND cv->>'id' = '__business_area__1'
      AND cv->>'text' IS NOT NULL
      AND cv->>'text' != ''
    GROUP BY cv->>'text'
    ORDER BY c DESC
    LIMIT 20
  `;
  console.log(`\nGhost Styles __business_area__1 distribution (top 20):`);
  for (const r of baCounts) console.log(`  ${(r.ba ?? "—").padEnd(30)} ${r.c}`);

  // Customer-name-at-start distribution
  const items = await db.mondayGhostItem.findMany({
    where: { boardId: stylesBoard.id },
    select: { name: true },
  });
  const firstTokenCounts = new Map<string, number>();
  for (const it of items) {
    // Take the leading "word" (letters + spaces until first non-alpha or "[")
    const m = it.name.match(/^([A-Za-z0-9.&\-+ ]+?)(?=\s*[\[\(\-_/—,]|\s*$)/);
    const token = (m?.[1] ?? "").trim();
    if (!token) continue;
    firstTokenCounts.set(token, (firstTokenCounts.get(token) ?? 0) + 1);
  }
  const sorted = Array.from(firstTokenCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`\nLeading customer-name tokens in Style item names (top 20):`);
  for (const [t, c] of sorted.slice(0, 20)) console.log(`  ${t.padEnd(30)} ${c}`);

  // How many of those tokens match an existing Customer.name (case-insensitive)?
  const lowerCustomers = new Map(customers.map((c) => [c.name.toLowerCase(), c]));
  const matched = sorted.filter(([t]) => lowerCustomers.has(t.toLowerCase()));
  console.log(`\nTokens that map to an existing Customer: ${matched.length}/${sorted.length}`);
  for (const [t, c] of matched.slice(0, 10)) console.log(`  ${t.padEnd(30)} ${c}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
