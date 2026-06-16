import { db } from "@/lib/db";
import { getCurrentOutputsForStyle } from "@/lib/outputs/current-outputs";

// Diagnostic: compare raw assets vs the derived current-outputs for a style,
// to confirm multi-document outputs stay individually reviewable.
//   tsx --env-file=.env scripts/inspect-current-outputs.ts <styleId>
const styleId = process.argv[2] ?? "cmq5jtppu07o7ffsaq05349m5";

async function main() {
  const jobs = await db.job.findMany({
    where: { styleId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true, variantKeys: true, _count: { select: { assets: true } } },
  });
  console.log("JOBS:");
  for (const j of jobs) {
    console.log(`  ${j.id.slice(-6)} ${j.status} ${j.createdAt.toISOString()} assets=${j._count.assets} vks=${JSON.stringify(j.variantKeys)}`);
  }

  const assets = await db.jobAsset.findMany({
    where: { job: { styleId, status: { not: "FAILED" } } },
    orderBy: { job: { createdAt: "desc" } },
    select: { variantKey: true, docType: true, reviewStatus: true, job: { select: { id: true } } },
  });
  console.log(`\nASSETS (${assets.length}):`);
  for (const a of assets) {
    console.log(`  ${(a.variantKey ?? "doc:" + a.docType).padEnd(40)} [${a.reviewStatus}] job=${a.job.id.slice(-6)}`);
  }

  const cur = await getCurrentOutputsForStyle(styleId);
  console.log(`\nCURRENT OUTPUTS (${cur.length}):`);
  for (const o of cur) {
    console.log(`  ${o.variantKey.padEnd(40)} "${o.name}" state=${o.state} asset=${o.jobAssetId ? "yes" : "no"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
