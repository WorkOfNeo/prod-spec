// =====================================================
// A process-wide memo for ONE value that many callers poll — "the import
// bell's counts". The value is recomputed at most once per `ttlMs`, and
// callers arriving while a computation is running share it instead of
// starting their own.
//
// Only for data that is the same for every caller (nothing per user, nothing
// per request) and that may trail the database by up to `ttlMs`. Callers that
// must read fresh call the loader directly, never through a memo.
//
// Freshness is bounded from when the computation STARTED: a value is served
// until ttlMs after the read that produced it began, so it can never be older
// than ttlMs. Once expired, the next caller waits for a fresh value — no
// stale-while-revalidate. A rejected computation is not remembered: everyone
// waiting on it gets the error, and the next caller gets a real attempt.
// =====================================================

export function ttlMemo<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { value: T; startedAt: number } | null = null;
  let pending: Promise<T> | null = null;

  return function get() {
    if (cached && now() - cached.startedAt < ttlMs) return Promise.resolve(cached.value);
    if (pending) return pending;
    const startedAt = now();
    const run: Promise<T> = Promise.resolve()
      .then(load)
      .then((value) => {
        cached = { value, startedAt };
        return value;
      })
      .finally(() => {
        if (pending === run) pending = null;
      });
    pending = run;
    return run;
  };
}
