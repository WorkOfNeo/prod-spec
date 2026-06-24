import { db } from "@/lib/db";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";

// =====================================================
// One-off cleanup: drop the two removed Kaufland carton-marking outputs
// from any ProdSpec that still references them.
//
//   npm exec tsx -- --env-file=.env scripts/remove-kaufland-carton-outputs.ts            # dry run
//   npm exec tsx -- --env-file=.env scripts/remove-kaufland-carton-outputs.ts --apply    # write
//
// The carton-marking specs were `static-pdf` passthroughs that emitted an
// ANNOTATED reference drawing (red field arrows, size/order callouts) as the
// actual print. They were deleted from the catalogue. The job runner already
// skips any output whose variantKey is no longer in the registry, so these
// rows can never ship the artwork — but they linger in the ProdSpec `outputs`
// JSON and cause a 404 on the preview endpoints. This removes them cleanly.
//
// Idempotent: ProdSpecs without these keys are left untouched.
// =====================================================

const APPLY = process.argv.includes("--apply");

const DEAD_KEYS = new Set([
  "kaufland-license-carton-marking-layout",
  "kaufland-private-label-carton-marking",
]);

async function main() {
  console.log(
    `Kaufland carton-marking output cleanup — ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`,
  );

  const specs = await db.prodSpec.findMany({ select: { id: true, name: true, outputs: true } });

  let changed = 0;
  let removed = 0;

  for (const s of specs) {
    const outputs = parseProdSpecOutputs(s.outputs);
    const kept = outputs.filter((o) => !DEAD_KEYS.has(o.variantKey));
    const drop = outputs.length - kept.length;
    if (drop === 0) continue;

    changed++;
    removed += drop;
    console.log(`${s.name} (${s.id}) — removing ${drop} output(s):`);
    for (const o of outputs) {
      if (DEAD_KEYS.has(o.variantKey)) console.log(`    - ${o.variantKey}`);
    }

    if (APPLY) {
      await db.prodSpec.update({
        where: { id: s.id },
        data: { outputs: kept as unknown as object },
      });
    }
  }

  console.log(
    `\nSummary (${APPLY ? "applied" : "dry run"}): ${removed} output row(s) across ${changed} ProdSpec(s).`,
  );
  if (changed === 0) console.log("Nothing to do — no ProdSpec references the removed carton-marking keys.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
