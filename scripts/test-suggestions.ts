import { computeSuggestions } from "@/lib/prod-spec/suggestions";
import { db } from "@/lib/db";

async function main() {
  const s = await computeSuggestions();
  console.log("Stats:", s.stats);
  console.log("\nNew BAs (" + s.newBusinessAreas.length + "):");
  for (const ba of s.newBusinessAreas) {
    console.log(`  ${ba.mondayValue.padEnd(28)} totalCount=${ba.totalCount}  perBoard=${ba.perBoard.map(b => `${b.boardLabel}:${b.count}`).join(", ")}`);
  }
  console.log("\nNew ProdSpec suggestions (" + s.newProdSpecs.length + ", top 20):");
  for (const p of s.newProdSpecs.slice(0, 20)) {
    console.log(
      `  ${p.customerName.padEnd(30)} × ${p.businessAreaName.padEnd(18)} (mondayValue=${p.businessAreaMondayValue})  matchCount=${p.matchCount}  sample="${p.sampleItems[0] ?? ""}"`,
    );
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
