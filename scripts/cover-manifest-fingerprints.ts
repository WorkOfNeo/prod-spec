// =====================================================
// Print one cover-manifest fingerprint per style, so two checkouts can be
// compared row for row.
//
// WHY THIS EXISTS. The "Trims on the cover" switch is supposed to be a true
// no-op while it is off: a cover generated after the trim work merges must read
// exactly as one generated before it. That is not a claim anybody should make
// from reading a diff. manifestFingerprint is the same string the runner stamps
// and the refresh sweep re-computes to decide whether a cover is worth
// rebuilding, so if it moves for a single style the whole book silently
// re-renders and re-pushes to suppliers. Run this on the feature branch and on
// a checkout of main, diff the two files, and the question is answered.
//
// Usage (from the worktree, so @/ and .env resolve):
//   node --import tsx --env-file=.env scripts/cover-manifest-fingerprints.ts \
//     --ids <file>            one style id per line; pass the SAME file to both
//                             checkouts or the comparison means nothing
//     [--sample 40]           instead of --ids: a deterministic sample, printed
//                             as ids so it can be replayed on the other side
//     [--force-trims]         resolve as if the switch were on — the control
//                             run: it proves the sample is actually sensitive
//                             to the trim layer, so a matching gated run is
//                             evidence rather than a tautology
//
// READ-ONLY. Selects styles and builds manifests; writes nothing.
// =====================================================

import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const forceTrims = argv.includes("--force-trims");

  const { db } = await import("@/lib/db");
  const { buildRequiredPackagingForStyle } = await import("@/lib/outputs/required-packaging");
  const { manifestFingerprint } = await import("@/lib/trims/manifest");

  const idsFile = flag("ids");
  let ids: string[];
  if (idsFile) {
    ids = readFileSync(idsFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } else {
    // Deterministic and biased towards styles that actually have a cover: a
    // sample of styles with no declared outputs would fingerprint as "[]" on
    // both sides and prove nothing.
    const take = Number(flag("sample") ?? 40);
    const rows = await db.style.findMany({
      where: { poNumber: { not: null }, prodSpec: { isNot: null } },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
    });
    ids = rows.map((r) => r.id);
  }

  for (const id of ids) {
    let fp: string;
    try {
      const docs = await buildRequiredPackagingForStyle(id, forceTrims ? { forceTrims: true } : undefined);
      fp = manifestFingerprint(docs);
    } catch (err) {
      fp = `ERROR ${(err as Error)?.message ?? String(err)}`;
    }
    console.log(`${id}\t${fp}`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
