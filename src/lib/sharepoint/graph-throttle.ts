// =====================================================
// A passive record of "Graph is currently telling us to slow down".
//
// WHY IT IS PASSIVE. The Graph SDK client is built with initWithMiddleware, so
// its own retry handler already honours Retry-After on a 429 and retries a few
// times. An error that escapes that has therefore ALREADY been backed off and
// retried — it means sustained throttling, not a blip. Nothing here retries, and
// nothing here changes what any Graph call does or returns: the note is written
// on the way out of a catch block that was already going to rethrow.
//
// WHO READS IT. The all-PO sweep. One folder audit does five or six Graph calls
// and is over; a sweep across every order does that a few hundred times in a
// row, and it is the only surface in the app that can turn a throttle into a
// sustained hammering. It asks `graphThrottleWaitMs()` between orders and
// sleeps for what it says. Per-PO surfaces do not consult this at all — a
// person waiting on one folder should get their answer or their error, not a
// silent pause.
//
// Process-local and deliberately so. It is a hint for pacing one loop, not a
// distributed rate limiter; a restarted process simply starts unthrottled and
// learns again from the first 429.
// =====================================================

// Statuses that mean "back off", as opposed to "this request was wrong".
// 503/504 are included because Graph returns them under load, and hammering a
// service that is already failing is the same mistake as ignoring a 429.
const BACKOFF_STATUSES = new Set([429, 503, 504]);

// Ceiling on one wait. Long enough to matter, short enough that a sweep left
// running overnight is not stalled forever by one bad minute.
const MAX_WAIT_MS = 120_000;

let waitUntil = 0;
let consecutive = 0;

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return null;
}

// Retry-After, when Graph sent one. Seconds per the spec; a date is ignored
// rather than parsed, because the exponential fallback is already correct and a
// mis-parsed date could stall a sweep for hours.
function retryAfterMs(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const raw =
    (headers as Record<string, unknown>)["retry-after"] ??
    (headers as Record<string, unknown>)["Retry-After"];
  const secs = Number(typeof raw === "string" || typeof raw === "number" ? raw : NaN);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_WAIT_MS) : null;
}

// Record a Graph failure. Anything that is not a throttle clears the streak —
// a 404 is not evidence that the service is under load.
export function noteGraphFailure(err: unknown): void {
  const status = statusOf(err);
  if (status == null || !BACKOFF_STATUSES.has(status)) {
    consecutive = 0;
    return;
  }
  consecutive += 1;
  // Retry-After when we were given one; otherwise 5s, 10s, 20s … capped.
  const wait = retryAfterMs(err) ?? Math.min(5_000 * 2 ** (consecutive - 1), MAX_WAIT_MS);
  waitUntil = Math.max(waitUntil, Date.now() + wait);
}

// A successful pass through the throttled section. Clears the streak so the
// next throttle starts its backoff from the bottom again.
export function noteGraphSuccess(): void {
  consecutive = 0;
}

// How long a batch loop should wait before its next unit of work. 0 = go.
export function graphThrottleWaitMs(): number {
  return Math.max(0, waitUntil - Date.now());
}

// How many throttles in a row we have seen. A caller that has been told to slow
// down over and over is looking at an outage, not at a busy minute, and should
// stop rather than keep recording folders it could not read.
export function graphThrottleStreak(): number {
  return consecutive;
}

// Test-only.
export function resetGraphThrottle(): void {
  waitUntil = 0;
  consecutive = 0;
}
