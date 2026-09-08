import { AsyncLocalStorage } from "node:async_hooks";

// =====================================================
// An OPT-IN, run-scoped memo for work that is pure for the duration of one
// pass — "load this style's render context", "load the doc-type catalogue".
//
// WHY IT IS OPT-IN, and why that is the whole design. Every loader wrapped in
// `runCached` below is shared with the job runner, the verify sweep, the
// delivery ledger and half a dozen pages. Those callers must keep reading the
// database exactly as often as they do today: a doc-type rule edited in one
// tab has to be visible in the next request, and a runner batch that ran for
// twenty minutes against a cached style would render yesterday's data. So
// there is NO ambient cache and no TTL. Outside a scope `runCached` is a
// straight pass-through — it calls the loader and returns, and the wrapped
// function behaves precisely as it did before it was wrapped.
//
// Inside `withRunCache(...)` — which today only the PO folder checks open, once
// per check — the same key resolves once. A PO check re-reads the same style's
// render context and the same doc-type catalogue several times per style, and
// the folder it is auditing cannot change between two reads inside one scan
// anyway: the scan already treats itself as a single snapshot, and
// apply-actions.ts re-runs the WHOLE check (in a fresh scope) before it writes.
//
// WHAT MAY BE CACHED HERE. Only values that are (a) derived from the database
// and (b) treated as READ-ONLY by every caller inside the scope. A cached value
// is shared by reference; a caller that mutated one would corrupt the next
// reader. Every current entry hands back plain data that its consumers only
// read.
//
// The promise, not the value, is stored — so two concurrent styles asking for
// the same catalogue share one query instead of racing to fill the slot. A
// rejected promise is evicted, so a transient failure is retried rather than
// remembered.
// =====================================================

type Store = Map<string, Promise<unknown>>;

const storage = new AsyncLocalStorage<Store>();

// Open a cache scope. Everything awaited inside — including work handed to a
// bounded-concurrency pool — shares one store, and the store is discarded when
// `fn` settles.
export function withRunCache<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(new Map(), fn);
}

// Resolve `key` once per scope. With no scope open, `load` runs every time —
// the pre-existing behaviour of every caller that has not opted in.
export function runCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return load();
  const hit = store.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = load().catch((err: unknown) => {
    // Never remember a failure: the next caller in this run should get a real
    // attempt, exactly as it would have without the cache.
    if (store.get(key) === pending) store.delete(key);
    throw err;
  });
  store.set(key, pending);
  return pending;
}

// True while a scope is open. Only for diagnostics — no behaviour should ever
// branch on it, because behaviour must not depend on whether a cache is there.
export function inRunCache(): boolean {
  return storage.getStore() !== undefined;
}
