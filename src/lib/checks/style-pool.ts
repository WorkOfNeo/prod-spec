// =====================================================
// A bounded-concurrency map for the per-style passes in run-po-checks.ts.
//
// WHY THIS EXISTS. Both per-style passes of a PO check are LATENCY-bound, not
// CPU-bound: each style costs a handful of small queries, and on Railway the
// database is reached over its public proxy, so nearly all of that time is the
// round trip. Run one style after another, a PO-length pile of that waiting is
// the check — the process idles, the database idles, and the wall clock is
// simply (styles × round trips). A 20-style PO is how that reaches the route's
// maxDuration and answers nothing.
//
// WHY BOUNDED, and not `Promise.all` over every style. The proxy and Postgres
// both cap connections, and one style's expectation is itself several queries.
// Firing every style at once does not make the queries faster; it moves the
// queueing inside the connection pool, where it is invisible, and lets one big
// PO starve every other request sharing the same client. A small fixed width
// keeps several round trips in the air at all times — which is the entire win —
// while staying inside the pool budget whatever the PO's size.
//
// Kept in its own module, free of every other import, so the ordering guarantee
// below can be tested for what it is: a pure property of the pool.
// =====================================================

// Enough to overlap the round trips, small enough that it is never the reason
// the pool is exhausted. Widening this is a pool-size decision, not a free one.
export const STYLE_CONCURRENCY = 5;

// Run `fn` over `items` with at most `limit` calls in flight, returning results
// in INPUT order.
//
// THE ORDERING IS THE POINT, not a nicety. A checks report is a diff someone
// reads and then acts on, and re-running the same check has to produce the same
// page: if rows landed in whatever order the database happened to answer, two
// identical checks would look like something had changed. Workers pull the next
// index and write into a pre-sized slot, so completion order never reaches the
// output.
//
// `fn` is expected to absorb its own failures — the callers catch per style, so
// that one unreadable style costs its own rows and no one else's. A rejection
// that does escape `fn` propagates, exactly as it did when these were plain
// `for` loops.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
