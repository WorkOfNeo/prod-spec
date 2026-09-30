// Pure debounce-ledger helpers for the automatic cover refresh. NO imports (no
// DB, no render chain) so they're trivially unit-testable; the async scheduler
// + processor in cover-regen-schedule.ts build on them. The ledger is a plain
// map of styleId → ISO-8601 due time, persisted as an AppSetting.

export type CoverRegenQueue = Record<string, string>;

// styleIds whose debounce window has elapsed (dueAt <= now). An unparseable
// timestamp is treated as due so a corrupt entry can't wedge a style forever.
export function dueStyleIds(queue: CoverRegenQueue, nowMs: number): string[] {
  return Object.entries(queue)
    .filter(([, entry]) => {
      const t = Date.parse(parseLedgerEntry(entry).dueAt);
      return !Number.isFinite(t) || t <= nowMs;
    })
    .map(([styleId]) => styleId);
}

// The ledger with the due entries removed — what we persist to CLAIM this
// drain's work before processing it, so the in-process timer and the cron
// backstop can't both bill the same style (an overlap is only a harmless
// double render). Corrupt entries are dropped (they count as due).
export function withoutDue(queue: CoverRegenQueue, nowMs: number): CoverRegenQueue {
  const remaining: CoverRegenQueue = {};
  for (const [styleId, entry] of Object.entries(queue)) {
    const t = Date.parse(parseLedgerEntry(entry).dueAt);
    if (Number.isFinite(t) && t > nowMs) remaining[styleId] = entry;
  }
  return remaining;
}

// ---- Retries ----------------------------------------------------------------
//
// A drained style whose cover render ERRORED used to simply vanish: the claim
// had already removed it from the ledger, and only a catastrophic drain failure
// put anything back. So one Chromium hiccup at the wrong moment left a cover
// saying "Waiting for Customer Information" about a line somebody had just
// approved, with nothing anywhere set to fix it. A failed style now goes back
// in the ledger with a backoff, a bounded number of times.
//
// The attempt count rides in the entry itself ("<iso>#<n>") so the ledger stays
// one flat string map: a plain ISO entry is attempt 0, and Date.parse on the
// ISO half keeps every existing entry and every helper above meaning the same.

export const MAX_REGEN_ATTEMPTS = 4;
const RETRY_BASE_MS = 60_000;

export function parseLedgerEntry(value: string): { dueAt: string; attempts: number } {
  const hash = value.lastIndexOf("#");
  if (hash === -1) return { dueAt: value, attempts: 0 };
  const attempts = Number(value.slice(hash + 1));
  return {
    dueAt: value.slice(0, hash),
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
  };
}

export function formatLedgerEntry(dueAt: string, attempts: number): string {
  return attempts > 0 ? `${dueAt}#${attempts}` : dueAt;
}

// The ledger after re-arming the styles whose render just failed. `claimed` is
// the entry each style had when this drain took it, so its attempt count
// carries forward. A style that has been re-stamped in the meantime (a fresh
// approval landed while we were rendering) is left alone — that newer demand
// already covers it and starts from zero. A style out of attempts is dropped
// and reported, so the caller can log it rather than retry forever.
export function rearmFailed(
  queue: CoverRegenQueue,
  failed: string[],
  claimed: CoverRegenQueue,
  nowMs: number,
): { queue: CoverRegenQueue; gaveUp: string[] } {
  const next: CoverRegenQueue = { ...queue };
  const gaveUp: string[] = [];
  for (const styleId of failed) {
    if (next[styleId]) continue;
    const attempts = parseLedgerEntry(claimed[styleId] ?? "").attempts + 1;
    if (attempts >= MAX_REGEN_ATTEMPTS) {
      gaveUp.push(styleId);
      continue;
    }
    const dueAt = new Date(nowMs + RETRY_BASE_MS * attempts).toISOString();
    next[styleId] = formatLedgerEntry(dueAt, attempts);
  }
  return { queue: next, gaveUp };
}
