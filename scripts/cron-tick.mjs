// Deterministic cron tick. Run by the Railway cron service (see
// railway.cron.json) — the ONE schedule that drives the whole pipeline:
//
//   every tick    POST /api/po-eans/run?sweep=1        EAN queue drain + retry sweep
//   every tick    POST /api/jobs/run?sweep=1           PDF job drain + generation backlog sweep
//   every tick    POST /api/cron/supplier-send?uploadOnly=1
//                                                      supplier-folder upload sweep + queue
//                                                      backfill (WS3) — cheap no-op when the
//                                                      queue is drained or sending is OFF
//   first tick of every 6th hour (00/06/12/18 UTC)
//                 POST /api/cron/sync-suppliers        supplier mirror refresh: sink + fill
//                                                      suppliers/contacts + retro-link styles.
//                                                      The supplier boards reject our webhook
//                                                      registration ("User unauthorized"), so
//                                                      this pull is what keeps suppliers fresh.
//   first tick of the digest hour (default 00:xx UTC)
//                 POST /api/cron/supplier-send         nightly digest — ONE email per supplier
//
// Order matters: supplier sync first (a fresh supplier link can flip
// countryOfOrigin readiness and backfills queue rows), then EANs (may enqueue
// generation), then generation (may auto-approve → enqueue supplier sends),
// then uploads (files in folders), digest last so the email's folder links
// are true. Every endpoint is idempotent and flag-gated server-side, so an
// extra or overlapping tick is harmless.
//
// Env (on the cron service):
//   PROD_SPEC_BASE_URL        required — the app's public base URL
//   JOB_RUNNER_SECRET         required — shared cron secret
//   CRON_TICK_MINUTES         optional, default 5 — MUST match the Railway
//                             cron schedule interval; gates the once-a-day
//                             digest window (fires when the tick lands in
//                             minutes [0, interval) of the digest hour)
//   SUPPLIER_DIGEST_HOUR_UTC  optional, default 0 — hour (UTC) the digest goes
//   SUPPLIER_SYNC_EVERY_HOURS optional, default 6 — supplier mirror refresh
//                             cadence; fires on the first tick of every hour
//                             divisible by it (0 disables)
//
// Why a Node script instead of a curl one-liner: the dashboard curl approach
// kept breaking on shell quirks — $VARs not expanding, the entrypoint echoing
// the command, the two URLs concatenating. Node reads process.env directly (no
// shell, no expansion, no quoting) and logs each call's status, so the cron
// logs themselves tell you exactly what happened.
const base = (process.env.PROD_SPEC_BASE_URL || "").replace(/\/+$/, "");
const secret = process.env.JOB_RUNNER_SECRET || "";

if (!base || !secret) {
  console.error(
    `[cron] missing env — PROD_SPEC_BASE_URL=${base ? "set" : "MISSING"} JOB_RUNNER_SECRET=${secret ? "set" : "MISSING"}`,
  );
  process.exit(1);
}

const interval = Math.max(1, Number(process.env.CRON_TICK_MINUTES || "5"));
const digestHourUtc = Number(process.env.SUPPLIER_DIGEST_HOUR_UTC || "0");
const supplierSyncEveryH = Number(process.env.SUPPLIER_SYNC_EVERY_HOURS || "6");
const now = new Date();
const isDigestTick =
  now.getUTCHours() === digestHourUtc && now.getUTCMinutes() < interval;
// Same first-tick-of-the-hour window as the digest, on every hour divisible
// by the cadence (default 6 → 00/06/12/18 UTC).
const isSupplierSyncTick =
  supplierSyncEveryH > 0 &&
  now.getUTCHours() % supplierSyncEveryH === 0 &&
  now.getUTCMinutes() < interval;

// Supplier sync first (fresh links flip readiness + backfill queue rows);
// EAN sweep next so any generation it enqueues is queued before the job
// drain; uploads after generation so runner auto-approvals land this tick.
const targets = [
  ...(isSupplierSyncTick
    ? [`/api/cron/sync-suppliers?secret=${encodeURIComponent(secret)}`]
    : []),
  `/api/po-eans/run?secret=${encodeURIComponent(secret)}&sweep=1`,
  `/api/jobs/run?secret=${encodeURIComponent(secret)}&sweep=1`,
  `/api/cron/supplier-send?secret=${encodeURIComponent(secret)}&uploadOnly=1`,
];
if (isDigestTick) {
  targets.push(`/api/cron/supplier-send?secret=${encodeURIComponent(secret)}`);
}

(async () => {
  console.log(
    `[cron] base=${base} digestTick=${isDigestTick} supplierSyncTick=${isSupplierSyncTick}`,
  );
  let failures = 0;
  for (const path of targets) {
    const label = path.split("?")[0] + (path.includes("uploadOnly=1") ? " (uploadOnly)" : ""); // never log the secret
    try {
      // Each endpoint self-limits to maxDuration 300s — cap the wait a hair
      // below so a hung call can't wedge the whole tick.
      const res = await fetch(base + path, {
        method: "POST",
        signal: AbortSignal.timeout(290_000),
      });
      const body = (await res.text()).slice(0, 300);
      console.log(`[cron] ${res.status} ${label} ${body}`);
      if (!res.ok) failures++;
    } catch (err) {
      failures++;
      console.error(`[cron] ERR ${label} ${err.message}`);
    }
  }
  process.exit(failures > 0 ? 1 : 0);
})();
