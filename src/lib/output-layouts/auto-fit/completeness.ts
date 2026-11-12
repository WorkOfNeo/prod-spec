// Which scanned styles are complete enough to sample — pure, see samples.ts.
//
// `missing` is each style's unresolvedTokens() on the face. A token missing on
// EVERY scanned style is "never filled" on this spec and doesn't disqualify
// anyone; any other missing token does.

export type ScannedStyle<T> = { sample: T; label: string; missing: string[] };

export function pickCompleteSamples<T>(scanned: ScannedStyle<T>[], take: number) {
  const neverFilled = (scanned[0]?.missing ?? []).filter((t) => scanned.every((s) => s.missing.includes(t)));
  const gaps = (s: ScannedStyle<T>) => s.missing.filter((t) => !neverFilled.includes(t));
  return {
    samples: scanned.filter((s) => gaps(s).length === 0).slice(0, take).map((s) => s.sample),
    neverFilled,
    incomplete: scanned.filter((s) => gaps(s).length > 0).map((s) => ({ label: s.label, missing: gaps(s) })),
  };
}
