// =====================================================
// Parity check: the batch current-outputs read must equal the single read.
//
// getCurrentOutputsForStyles (one query per kind, used by /dashboard and the
// /reviews board) and getCurrentOutputsForStyle (the review page, runner,
// delivery ledger, checks, style page) share one pure derivation, but load
// their rows differently. This script proves the loads agree: for every style
// in the database it deep-compares getCurrentOutputsForStyle(id) with
// getCurrentOutputsForStyles(ids).get(id) and exits 1 on any difference.
//
// READ-ONLY.
//
//   DATABASE_URL=… npx tsx scripts/perf/parity-current-outputs.ts
//   npx tsx --env-file=.env scripts/perf/parity-current-outputs.ts --limit 500
//   … --batch 200        styles per batch call (default 200)
//   … --concurrency 8    parallel single reads (default 8)
// =====================================================
import { isDeepStrictEqual } from "node:util";

// Accepts both "--name N" and "--name=N".
const numArg = (name: string, fallback: number | null): number | null => {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return fallback;
  const raw = process.argv[i].includes("=")
    ? process.argv[i].split("=")[1]
    : process.argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} needs a positive integer`);
  return n;
};

// A style id no row has — the batch must answer [] for it, as the single read does.
const MISSING_ID = "__parity_missing_style__";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const limit = numArg("limit", null);
  const batchSize = numArg("batch", 200)!;
  const concurrency = numArg("concurrency", 8)!;

  // Imported after the env check: @/lib/db builds its client at import time.
  const { db } = await import("@/lib/db");
  const { getCurrentOutputsForStyle, getCurrentOutputsForStyles } = await import(
    "@/lib/outputs/current-outputs"
  );

  const styles = await db.style.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
    ...(limit ? { take: limit } : {}),
  });
  const ids = [...styles.map((s) => s.id), MISSING_ID];
  console.log(`Comparing ${styles.length} styles (+1 missing id), batches of ${batchSize}…`);
  // Warm the lazy imports and the layout-variant load so neither timing pays them.
  await getCurrentOutputsForStyle(MISSING_ID);

  let outputs = 0;
  let mismatches = 0;
  let singleMs = 0;
  let batchMs = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);

    let t = Date.now();
    const batch = await getCurrentOutputsForStyles(chunk);
    batchMs += Date.now() - t;

    t = Date.now();
    const single = new Map<string, Awaited<ReturnType<typeof getCurrentOutputsForStyle>>>();
    const queue = [...chunk];
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          single.set(id, await getCurrentOutputsForStyle(id));
        }
      }),
    );
    singleMs += Date.now() - t;

    if (batch.size !== chunk.length) {
      mismatches++;
      console.error(`✗ batch returned ${batch.size} entries for ${chunk.length} ids`);
    }
    for (const id of chunk) {
      const want = single.get(id)!;
      const got = batch.get(id);
      outputs += want.length;
      if (isDeepStrictEqual(want, got)) continue;
      mismatches++;
      console.error(`✗ ${id}: single ${want.length} outputs, batch ${got?.length ?? "missing"}`);
      const n = Math.max(want.length, got?.length ?? 0);
      for (let k = 0; k < n; k++) {
        if (isDeepStrictEqual(want[k], got?.[k])) continue;
        console.error(`    [${k}] single: ${JSON.stringify(want[k])}`);
        console.error(`    [${k}]  batch: ${JSON.stringify(got?.[k])}`);
        break;
      }
    }
    console.log(`  ${Math.min(i + batchSize, ids.length)}/${ids.length} checked`);
  }

  console.log(
    `${mismatches === 0 ? "✓ parity" : "✗ MISMATCH"}: ${styles.length} styles, ${outputs} outputs, ` +
      `${mismatches} difference(s). single reads ${singleMs} ms, batch reads ${batchMs} ms.`,
  );
  return mismatches === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
