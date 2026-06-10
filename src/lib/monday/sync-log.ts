// Structured stdout logging for the Monday sync/sink paths.
//
// These run as long-lived admin POSTs on Railway. Progress and failures
// were previously written only to SyncJob DB rows + the returned JSON, so
// the server log stream stayed empty — a silent failure (or a slow
// 5k-item run) looked like "nothing happened". Every line is prefixed
// `[monday-sync:<scope>]` so it's easy to grep/filter in Railway, matching
// the existing `[runner]` / `[ean-runner]` convention elsewhere in the app.

export function slog(scope: string, message: string, extra?: Record<string, unknown>): void {
  const tail = extra && Object.keys(extra).length ? ` ${compact(extra)}` : "";
  console.log(`[monday-sync:${scope}] ${message}${tail}`);
}

export function serr(scope: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err == null ? "" : String(err);
  console.error(`[monday-sync:${scope}] ERROR ${message}${detail ? ` — ${detail}` : ""}`);
}

function compact(o: Record<string, unknown>): string {
  return Object.entries(o)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

// Per-scope error sampler. Logs the first `cap` errors in full, then goes
// quiet so a board where every one of 5k items fails doesn't emit 5k
// lines — while still counting how many were suppressed. Call `.done()`
// at the end of the loop to emit the suppressed-count summary.
export function errorSampler(scope: string, cap = 20) {
  let seen = 0;
  return {
    record(message: string, err: unknown): void {
      seen++;
      if (seen <= cap) serr(scope, message, err);
      else if (seen === cap + 1) serr(scope, `…further errors suppressed (cap ${cap})`);
    },
    done(): void {
      if (seen > cap) serr(scope, `${seen} errors total this run (${seen - cap} suppressed above)`);
    },
    get count(): number {
      return seen;
    },
  };
}
