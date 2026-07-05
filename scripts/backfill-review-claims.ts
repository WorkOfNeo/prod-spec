// scripts/backfill-review-claims.ts
//
// One-off repair for the 2026-07-05 bulk "Regenerate all (keep approved)"
// run: full regens created fresh unclaimed jobs, dropping every in-progress
// review back into the untouched /reviews queue. This restores review
// continuity retroactively — for each style whose NEWEST awaiting-review job
// is unclaimed and undecided, carry the owner forward from the prior started
// round (same findCarryForwardClaim rule the runner now applies live).
//
//   tsx --env-file=.env scripts/backfill-review-claims.ts           # dry run
//   tsx --env-file=.env scripts/backfill-review-claims.ts --apply   # write
//
// Idempotent: styles whose newest job already carries a claim (or has a
// human decision) are skipped, so re-running it is safe. Tickets superseded
// by the bulk run are NOT reopened — a full regen is deliberately a fresh
// round (PR #169); this restores WHO owns the review, not the old threads.
import { db } from "@/lib/db";
import { findCarryForwardClaim } from "@/lib/review-flow/claim";

const apply = process.argv.includes("--apply");

async function main() {
  // Newest AWAITING_REVIEW job per style, with claim + human-decision state.
  const jobs = await db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      styleId: true,
      createdAt: true,
      triggerSource: true,
      reviewClaimedById: true,
      style: { select: { name: true } },
      assets: {
        where: { reviewStatus: { not: "PENDING_REVIEW" }, reviewedById: { not: null } },
        take: 1,
        select: { id: true },
      },
    },
  });

  const newestByStyle = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) if (!newestByStyle.has(j.styleId)) newestByStyle.set(j.styleId, j);

  let restored = 0;
  let untouchedFresh = 0;
  let alreadyOwned = 0;

  for (const job of newestByStyle.values()) {
    if (job.reviewClaimedById != null || job.assets.length > 0) {
      alreadyOwned++;
      continue;
    }
    const claim = await findCarryForwardClaim(job.styleId, job.id);
    if (!claim) {
      untouchedFresh++;
      continue;
    }
    const user = await db.user.findUnique({ where: { id: claim.userId }, select: { email: true } });
    console.log(
      `${apply ? "RESTORE" : "would restore"} ${job.style.name} → ${user?.email ?? claim.userId}` +
        ` (claimed ${claim.at.toISOString().slice(0, 16)}, current job ${job.triggerSource} @ ${job.createdAt.toISOString().slice(0, 16)})`,
    );
    if (apply) {
      await db.job.update({
        where: { id: job.id },
        data: { reviewClaimedById: claim.userId, reviewClaimedAt: claim.at },
      });
    }
    restored++;
  }

  console.log(
    `\n${apply ? "Restored" : "Dry run — would restore"} ${restored} style(s); ` +
      `${alreadyOwned} already owned/decided; ${untouchedFresh} had no prior started round (stay in queue).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit());
