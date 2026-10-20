// Display metadata for StyleEanStatus — shared by the PO barcodes table and
// the Styles list so the badge label + colour are identical everywhere.
// Plain data (no server imports) so it's safe in client components.
export const EAN_STATUS_META: Record<string, { label: string; cls: string }> = {
  NONE: { label: "not queued", cls: "bg-zinc-100 text-zinc-600" },
  PENDING: { label: "queued", cls: "bg-blue-100 text-blue-700" },
  RESOLVING: { label: "resolving…", cls: "bg-blue-100 text-blue-700" },
  RESOLVED: { label: "resolved", cls: "bg-emerald-100 text-emerald-800" },
  RESOLVED_FROM_MONDAY: { label: "resolved (Monday)", cls: "bg-teal-100 text-teal-800" },
  PARTIAL: { label: "partial", cls: "bg-amber-100 text-amber-800" },
  PO_FOUND_NO_EANS: { label: "PO has no barcodes", cls: "bg-orange-100 text-orange-800" },
  PO_NOT_FOUND: { label: "PO not found", cls: "bg-red-100 text-red-700" },
  STYLE_NOT_IN_PO: { label: "style not in PO", cls: "bg-rose-100 text-rose-700" },
  ERROR: { label: "error", cls: "bg-red-100 text-red-700" },
};

export function eanStatusMeta(status: string): { label: string; cls: string } {
  return EAN_STATUS_META[status] ?? { label: status.toLowerCase(), cls: "bg-zinc-100 text-zinc-600" };
}

// Max consecutive non-resolved scrape attempts before a row stops auto-
// retrying and "floats" for manual attention. The retry sweep caps on this
// (src/lib/po/ean-runner.ts) and the /po-eans table surfaces it.
export const MAX_EAN_ATTEMPTS = 3;

// The non-resolved statuses the sweep retries — i.e. the ones that can float
// once attempts run out. Keep in sync with RETRYABLE in ean-runner.ts.
// Exported so server pages can build the same "floated" Prisma filter the
// /automation badge counts with (eanStatus in here + attempts >= MAX).
export const FLOATABLE_STATUSES = [
  "PO_FOUND_NO_EANS",
  "PO_NOT_FOUND",
  // A re-issued PO may add the style later, so retry a few times, then float.
  "STYLE_NOT_IN_PO",
  "ERROR",
] as const;
const FLOATABLE_SET = new Set<string>(FLOATABLE_STATUSES);

// A row has "floated" when it's in a retryable-but-unresolved state and has
// burned its attempt budget — the FAST LANE will no longer pick it up. It is
// not abandoned: the recycle lane below re-checks it on a slow cycle.
export function eanFloated(status: string, attempts: number): boolean {
  return attempts >= MAX_EAN_ATTEMPTS && FLOATABLE_SET.has(status);
}

// ------------------------------------------------------------ recycle lane
//
// The fast lane gives a fresh PO 3 strikes over ~1.5 days and then stops. But
// the dominant failure — "PO has no barcodes" — is a TIMING problem: the
// supplier simply hasn't added the barcode page to the PO yet, and the only
// way to discover that they have is to scrape again. So floated rows drop into
// a slow background cycle instead of resting forever.
//
// Ordering is least-recently-checked first, so the pile rotates on its own —
// a re-check stamps eanResolvedAt, which sends the row to the back.

const DAY_MS = 24 * 60 * 60 * 1000;

// Minimum age of a row's last check before the recycle lane looks at it again.
// THIS is the real throttle, not the daily quota: the in-scope pile is small
// (it follows the PO cutoff), so without an age floor the cycle would lap
// several times a day and re-download the same PO PDFs from SharePoint.
export const RECYCLE_MIN_AGE_MS = 3 * DAY_MS;

// Safety cap on recycle re-checks per rolling 24h, across every sweep. Sized
// so a sudden pile (e.g. the cutoff being lowered) can't turn into a scrape
// storm. With a small pile the age floor binds first and this never applies.
export const RECYCLE_DAILY_QUOTA = 300;

// Per-sweep slice. The EAN cron ticks every ~5 min (~288×/day), so 2 per tick
// is ~576/day of headroom — comfortably above the quota, which does the real
// capping. Keeps any single tick cheap (a scrape averages ~2s).
export const RECYCLE_PER_TICK = 2;

// CronRun.kind for recycle passes — separate from the "po-eans" fast lane so
// the two are distinguishable on /automation and the 24h quota can be summed.
export const RECYCLE_CRON_KIND = "po-eans-recycle";

// Which lane a PO'd style is in, for display. "parked" rows are below the PO
// cutoff: the automation never touches them, so promising a next check would
// be a lie — only a manual Re-resolve moves them.
export type EanLane =
  | { kind: "active" }
  | { kind: "cycling"; nextCheckAt: Date }
  | { kind: "parked" };

export function eanLane(args: {
  status: string;
  attempts: number;
  poSeq: number | null;
  cutoff: number | null;
  lastCheckedAt: Date | null;
  // How many due rows the cycle will re-check BEFORE this one (0 = next up).
  aheadInQueue: number;
  now: Date;
}): EanLane {
  const belowCutoff =
    args.cutoff !== null && (args.poSeq === null || args.poSeq < args.cutoff);
  if (belowCutoff) return { kind: "parked" };
  if (!eanFloated(args.status, args.attempts)) return { kind: "active" };
  return {
    kind: "cycling",
    nextCheckAt: nextRecycleAt(args.lastCheckedAt, args.aheadInQueue, args.now),
  };
}

// When the recycle lane will next reach this row. Two things gate it: the row
// must be older than the age floor, and it must fit inside the daily quota
// once the rows ahead of it are served. Never returns a past time — a row
// that's already due reads as "next check: due now", not a stale date.
export function nextRecycleAt(
  lastCheckedAt: Date | null,
  aheadInQueue: number,
  now: Date,
  quotaPerDay: number = RECYCLE_DAILY_QUOTA,
): Date {
  // A row that was never checked is due immediately.
  const dueAt = lastCheckedAt ? lastCheckedAt.getTime() + RECYCLE_MIN_AGE_MS : now.getTime();
  // Quota backlog: every full quota's worth of rows ahead pushes this out a day.
  const backlogDays = Math.floor(Math.max(0, aheadInQueue) / Math.max(1, quotaPerDay));
  return new Date(Math.max(dueAt, now.getTime()) + backlogDays * DAY_MS);
}
