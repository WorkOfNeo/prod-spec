import { db } from "@/lib/db";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { outputConfigKey } from "@/lib/outputs/output-config-key";

// =====================================================
// One-time backfill: stamp JobAsset.outputConfigKey on the LATEST asset per
// (style, output) with the CURRENT config fingerprint of that output. Run once
// after `prisma migrate deploy` adds the column.
//
//   npm run backfill-output-config-key            # dry run — counts only
//   npm run backfill-output-config-key -- --apply # write the keys
//
// WHY: the ProdSpec Outputs-tab "Run all" surfaces treat a null key as
// "unknown → not changed", so before this runs, a config edit isn't detected on
// the EXISTING backlog (only assets rendered after deploy carry a key). This
// stamps the current key onto today's latest assets — declaring them "up to
// date as of now" — so the NEXT edit to an output flips its styles to "changed"
// and they surface in Run all. It never marks anything changed itself (it
// writes the current key, which by definition matches), and it's idempotent:
// only null-key assets are touched, so re-running is a no-op.
//
// Scope: latest asset per (style, full variantKey) across non-FAILED jobs — the
// exact rows the detectors read. Superseded/older assets and bundle pages
// (cover / general info, no matching spec output) are left null.
// =====================================================

const APPLY = process.argv.includes("--apply");

const base = (variantKey: string) => variantKey.split("#")[0];

async function main() {
  const specs = await db.prodSpec.findMany({ select: { id: true, name: true, outputs: true } });
  console.log(`${specs.length} prod specs to scan${APPLY ? "" : " (dry run)"}\n`);

  let scannedAssets = 0;
  let toStamp = 0;
  let stamped = 0;
  let skippedNoOutput = 0;

  for (const spec of specs) {
    let currentKeys: Map<string, string>;
    try {
      currentKeys = new Map(parseProdSpecOutputs(spec.outputs).map((o) => [base(o.variantKey), outputConfigKey(o)]));
    } catch {
      currentKeys = new Map();
    }
    if (currentKeys.size === 0) continue;

    const styles = await db.style.findMany({
      where: { prodSpecId: spec.id, archivedAt: null, deletedAt: null },
      select: { id: true },
    });
    if (styles.length === 0) continue;

    // Only assets still missing a key (idempotent), newest job first so the
    // first-seen per full variantKey is the current one the detectors read.
    const assets = await db.jobAsset.findMany({
      where: {
        job: { styleId: { in: styles.map((s) => s.id) }, status: { not: "FAILED" } },
        variantKey: { not: null },
        outputConfigKey: null,
      },
      orderBy: { job: { createdAt: "desc" } },
      select: { id: true, variantKey: true, job: { select: { styleId: true } } },
    });

    // key value → asset ids to stamp with it. Only the newest asset per
    // (style, full variantKey) is taken.
    const seen = new Set<string>();
    const byKey = new Map<string, string[]>();
    for (const a of assets) {
      scannedAssets++;
      if (!a.variantKey) continue;
      const seenKey = `${a.job.styleId}::${a.variantKey}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      const key = currentKeys.get(base(a.variantKey));
      if (!key) {
        skippedNoOutput++; // output no longer in the spec (or a bundle page)
        continue;
      }
      toStamp++;
      const ids = byKey.get(key);
      if (ids) ids.push(a.id);
      else byKey.set(key, [a.id]);
    }

    if (APPLY && byKey.size > 0) {
      for (const [key, ids] of byKey) {
        // Chunk to keep the IN list sane on large specs.
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          const res = await db.jobAsset.updateMany({
            where: { id: { in: chunk } },
            data: { outputConfigKey: key },
          });
          stamped += res.count;
        }
      }
      console.log(`  ${spec.name}: stamped ${byKey.size} distinct keys`);
    }
  }

  console.log(
    `\nScanned ${scannedAssets} null-key assets · ${toStamp} eligible (latest per style+output) · ` +
      `${skippedNoOutput} skipped (no matching spec output).`,
  );
  console.log(APPLY ? `Stamped ${stamped} assets.` : `Dry run — re-run with --apply to write.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
