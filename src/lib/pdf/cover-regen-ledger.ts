// Pure debounce-ledger helpers for the automatic cover refresh. NO imports (no
// DB, no render chain) so they're trivially unit-testable; the async scheduler
// + processor in cover-regen-schedule.ts build on them. The ledger is a plain
// map of styleId → ISO-8601 due time, persisted as an AppSetting.

export type CoverRegenQueue = Record<string, string>;

// styleIds whose debounce window has elapsed (dueAt <= now). An unparseable
// timestamp is treated as due so a corrupt entry can't wedge a style forever.
export function dueStyleIds(queue: CoverRegenQueue, nowMs: number): string[] {
  return Object.entries(queue)
    .filter(([, iso]) => {
      const t = Date.parse(iso);
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
  for (const [styleId, iso] of Object.entries(queue)) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t > nowMs) remaining[styleId] = iso;
  }
  return remaining;
}
