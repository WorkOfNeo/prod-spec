// Deterministic cron tick. Run by the Railway cron service (see
// railway.cron.json): drains the PO→EAN queue (with the retry sweep) then the
// PDF job queue + generation backlog sweep, by POSTing the two runner
// endpoints with ?sweep=1 so each run is also recorded on /automation.
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

// EAN sweep first so any generation it enqueues is queued before the job drain.
const targets = [
  `/api/po-eans/run?secret=${encodeURIComponent(secret)}&sweep=1`,
  `/api/jobs/run?secret=${encodeURIComponent(secret)}&sweep=1`,
];

(async () => {
  console.log(`[cron] base=${base}`);
  let failures = 0;
  for (const path of targets) {
    const label = path.split("?")[0]; // never log the secret
    try {
      const res = await fetch(base + path, { method: "POST" });
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
