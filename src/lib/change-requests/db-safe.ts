// Readers of the change-request tables must keep pages up in the window
// between a merge and `prisma migrate deploy` (Railway runs the migration on
// release, the new code can boot first). A missing table (P2021) or a missing
// column (P2022 — the same race one migration later) therefore reads as
// "nothing there yet" instead of a 500.
//
// FAIL-SOFT FOR READS ONLY. Writers let the error surface: a draft, a publish
// or a request that silently went nowhere is worse than a visible failure.
// Every other error is rethrown untouched.

export function isMissingTable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "P2022";
}

// Await a read; a missing table/column yields `fallback` (an empty list, null,
// a zero count). Takes the Prisma query itself, which is lazy until awaited.
export async function orEmpty<T>(promise: PromiseLike<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isMissingTable(err)) return fallback;
    throw err;
  }
}
