// =====================================================
// Duration-aware batch sizing for the PO→EAN cron drain.
//
// The drain used to process a FIXED 5 styles per sweep, which turns a large
// backlog into a multi-day trickle (5/style × one sweep every ~5 min). Instead
// we size each sweep from how long recent sweeps actually took: aim to fill a
// fixed wall-clock budget, so throughput adapts to the real per-scrape cost
// (which drifts with PO size / SharePoint latency) with no magic constants to
// re-tune. The runner ALSO enforces a soft deadline mid-loop (softDeadlineMs)
// as the real overrun guard — this only sets the target COUNT.
//
// "Safe" profile: ~150s of work per sweep, capped at 40 styles, so a sweep
// stays well under the route's 300s maxDuration and never overlaps the ~5-min
// cron cadence, even if a batch hits a few slow giant-PDF scrapes.
// =====================================================

export const EAN_BATCH = {
  // Target wall-clock budget a single sweep aims to fill.
  targetBudgetMs: 150_000,
  // Never drop below this (keeps a trickle alive when history is noisy) …
  min: 5,
  // … and never exceed this (Safe cap — bounds worst-case sweep length and
  // concurrent SharePoint load).
  max: 40,
  // Assumed per-style cost before any history exists (≈ observed avg ~2.9s,
  // rounded up so the very first sweeps stay conservative).
  fallbackMsPerStyle: 3_000,
  // Mid-loop the runner stops claiming NEW styles once elapsed passes this,
  // even if the target count isn't reached. Below the 300s route maxDuration
  // with headroom for one in-flight scrape to finish.
  softDeadlineMs: 240_000,
} as const;

export type EanBatchConfig = typeof EAN_BATCH;

// Per-style estimate from recent per-sweep samples (each = a sweep's
// durationMs / processed): the median cost (upper of the two middles for an
// even count — a slight conservative lean), robust to the odd giant-PDF
// outlier. It only needs to be a reasonable central estimate: the mid-loop
// soft deadline (runPendingEanResolutions) is the real overrun guard, so an
// over-large batch on a slow sweep is simply capped by wall-clock, not cost.
// Pure so it's unit-tested without touching the DB.
export function computeBatchSize(
  perStyleMsSamples: readonly number[],
  cfg: EanBatchConfig = EAN_BATCH,
): number {
  const samples = perStyleMsSamples
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  const perStyleMs = samples.length
    ? samples[Math.floor(samples.length / 2)] // upper median
    : cfg.fallbackMsPerStyle;

  // Guard against an implausibly tiny estimate blowing the batch past max.
  const raw = Math.floor(cfg.targetBudgetMs / Math.max(perStyleMs, 500));
  return Math.min(Math.max(raw, cfg.min), cfg.max);
}
