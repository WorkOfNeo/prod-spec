// =====================================================
// Is the trims layer on for THIS cover?
//
// There are two switches and they compose by OR:
//
//   * the global AppSetting `trimsOnCoverEnabled` — the release switch, off
//     until the whole book moves over;
//   * `ProdSpec.trimsOnCoverEnabled` — a per-spec opt-in, so one customer can
//     be moved onto the new cover for a live request without deciding it for
//     everybody.
//
// WHY OR, AND WHY THAT MATTERS. OR is the only composition with no fallback to
// fall back FROM. A spec ticked on before the global flip keeps working after
// it; turning the global back off never strands a spec somebody switched on
// deliberately; and no ordering of the two switches can produce a cover that
// silently loses its trims. The per-spec column can only ever turn the layer
// ON — it is not an override and cannot suppress the global.
//
// NOT `forceTrims`. That is a third thing entirely: a per-call bypass reserved
// for callers that render a sample and hand the bytes straight back, persisting
// nothing (see force-trims-containment.test.ts, which fails if a new caller
// forces it on a path that writes). Enablement here is real: what it turns on
// gets generated, fingerprinted and delivered.
//
// THE TWO CALLERS MUST AGREE. buildRequiredPackagingForStyle and the runner
// both decide this, and if they ever disagree about one style the fingerprint
// the runner stamps never matches the one the refresh sweep computes — and that
// style's cover rebuilds, re-pushes and rebuilds again forever. They resolve
// through this one function so there is nothing to keep in sync by hand.
//
// PURE-ISH: the resolver below takes the spec's flag as a value so it can be
// unit-tested without a database; the DB read is the thin wrapper under it.
// =====================================================

// The whole rule, as a function of its two inputs. Kept separate from the read
// so the composition is testable on its own — it is the part that has to be
// right, and it is three lines.
export function trimsEnabledFor(input: {
  globalEnabled: boolean;
  specEnabled: boolean | null | undefined;
}): boolean {
  return input.globalEnabled || input.specEnabled === true;
}

// The same rule, resolved for a style's prod spec.
//
// Fail-soft on both reads, matching the runner's existing stance: a settings
// hiccup must never fail a generation, and "off" is the safe fallback because
// it is what covers already print.
export async function trimsEnabledForProdSpec(prodSpecId: string | null | undefined): Promise<boolean> {
  const { getTrimsOnCoverEnabled } = await import("@/lib/settings/app-settings");
  const globalEnabled = await getTrimsOnCoverEnabled().catch(() => false);
  if (globalEnabled) return true; // no need to read the spec — OR is already satisfied
  if (!prodSpecId) return false;

  const { db } = await import("@/lib/db");

  // Catch-all on purpose, and it covers a real window: between this code
  // merging and the migration running, `trimsOnCoverEnabled` does not exist on
  // prod_specs and Prisma raises P2022. Railway runs migrate deploy BEFORE
  // start, so that window is narrow — but the failure mode if we let it throw
  // is no cover at all, which is far worse than a spec not yet reading as
  // opted-in. Same stance as the packaging-rows loader's P2021 fallback.
  const spec = await db.prodSpec
    .findUnique({ where: { id: prodSpecId }, select: { trimsOnCoverEnabled: true } })
    .catch(() => null);

  return trimsEnabledFor({ globalEnabled: false, specEnabled: spec?.trimsOnCoverEnabled });
}
