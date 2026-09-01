// =====================================================
// Assembling the cover's "Required packaging" manifest from BOTH sources.
//
// Until now the manifest was the ProdSpec's declared output set — i.e. only
// what this app produces. Measured live, that misses an artwork item on 5,512
// of 5,960 styles, which is the whole of the supplier's complaint: they get a
// three-line list for an eight-item order and cannot tell whether the rest was
// forgotten or is simply coming from somewhere else.
//
// The manifest is therefore the UNION of two lists, and it has to be a union
// rather than either one alone:
//
//   * Monday's Trims column is the buyer's list of what the order needs. It is
//     the one the supplier and the buyer already talk in, so it leads, and each
//     entry prints VERBATIM so the two can be ticked off against each other.
//   * The declared outputs are what we will actually deliver. Monday is not
//     complete either — 1,729 live styles are sent a care label their Trims
//     column never mentions — so an output nobody asked for is still listed,
//     never dropped.
//
// ONE ROW PER MONDAY ENTRY. A compound entry ("Hanger & Hangtag", 220 styles)
// names two things and resolves to two concepts, but it stays ONE row: the
// point of the table is that a person can read it beside the Monday cell and
// tick straight down. Its kind is then the strongest of its concepts —
// app-generated beats manually-supplied beats packing-note — because the row
// has to advertise the strongest promise it makes.
//
// Pure and unit-tested: no db, no Graph, no clock. The DB read that feeds it
// lives in src/lib/outputs/required-packaging.ts.
// =====================================================

import type { BundleDocSummary } from "@/lib/pdf/bundle-page-keys";
import { conceptHasArtwork } from "./concepts";
import { DEFAULT_TRIM_CONCEPT_COPY, resolveTrimCopy, type TrimConceptCopyMap } from "./concept-copy";
import { classifyTrimLabel, normalizeTrimLabel, type TrimRule } from "./classify";

export type ManifestKind = NonNullable<BundleDocSummary["kind"]>;

// One declared output, already resolved by the caller (variant looked up, dims
// resolved, approval decided) and tagged with the concept it satisfies.
export type ManifestOutput = {
  variantKey: string;
  displayName: string;
  widthMm: number;
  heightMm: number;
  fileCount: number | null;
  approved: boolean;
  // null ⇒ the layout's name didn't classify and no override was set. The
  // output is still listed; it just can't be matched to a Monday entry.
  concept: string | null;
};

export type TrimManifestInput = {
  // Monday's Trims entries, verbatim and in board order.
  trimLabels: ReadonlyArray<string>;
  outputs: ReadonlyArray<ManifestOutput>;
  rules: ReadonlyArray<TrimRule>;
  // Normalised label -> concepts. An EMPTY array means "not a trim" and hides
  // the row entirely — the escape hatch for junk values like "as PO00000".
  overrides: Readonly<Record<string, string[]>>;
  // Normalised labels of manually-supplied trims whose file has been found in
  // the order's SharePoint folder. The hook for the delivery-detection half;
  // absent ⇒ nothing is known to be delivered and manual rows read as pending.
  manualDelivered?: ReadonlySet<string>;
  // Per-concept supplier-facing wording (see concept-copy.ts). Absent ⇒ the
  // built-in defaults, so a caller that knows nothing about copy still prints
  // the standing notes.
  conceptCopy?: TrimConceptCopyMap;
};

// Strongest-first. A row advertising "we produce this" must not be downgraded
// by a second concept in the same compound entry.
const KIND_RANK: Record<ManifestKind, number> = { app: 3, manual: 2, info: 1 };

// Ranking helper shared with the settings screen, so "which kind won" is
// decided in one place.
export function strongestKind(kinds: ReadonlyArray<ManifestKind>): ManifestKind {
  return kinds.reduce<ManifestKind>((best, k) => (KIND_RANK[k] > KIND_RANK[best] ? k : best), "info");
}

// The concepts one Monday entry resolves to. A stored decision beats the rules
// outright — including the empty-array "not a trim" decision, which is why the
// lookup tests for KEY PRESENCE rather than truthiness.
export function conceptsForLabel(
  label: string,
  rules: ReadonlyArray<TrimRule>,
  overrides: Readonly<Record<string, string[]>>,
): string[] {
  const key = normalizeTrimLabel(label);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return classifyTrimLabel(label, rules).concepts;
}

// Is this entry deliberately configured as "not packaging"? Distinct from
// "no rule matched": an unmapped label still prints (the supplier was told to
// expect it), a suppressed one does not.
export function isSuppressedLabel(
  label: string,
  overrides: Readonly<Record<string, string[]>>,
): boolean {
  const key = normalizeTrimLabel(label);
  return Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key].length === 0;
}

// Spread helper: an absent resolution must leave the KEY off the row, not set
// it to undefined — `copy: undefined` and no `copy` at all serialise the same
// in the fingerprint today, but only the latter survives a future JSON round
// trip unchanged.
function copyField(copy: ReturnType<typeof resolveTrimCopy>): { copy?: { note?: string } } {
  return copy ? { copy } : {};
}

export function assembleTrimManifest(input: TrimManifestInput): BundleDocSummary[] {
  const { trimLabels, outputs, rules, overrides } = input;
  const manualDelivered = input.manualDelivered ?? new Set<string>();
  const conceptCopy = input.conceptCopy ?? DEFAULT_TRIM_CONCEPT_COPY;

  // concept -> the outputs that satisfy it. Several layouts can share one
  // concept (a front and a side carton marking); all of them answer the entry.
  const byConcept = new Map<string, ManifestOutput[]>();
  for (const o of outputs) {
    if (!o.concept) continue;
    const list = byConcept.get(o.concept);
    if (list) list.push(o);
    else byConcept.set(o.concept, [o]);
  }

  const rows: BundleDocSummary[] = [];
  const claimed = new Set<string>();

  // ---- Monday's list leads, in board order.
  for (const label of trimLabels) {
    if (isSuppressedLabel(label, overrides)) continue;
    const concepts = conceptsForLabel(label, rules, overrides);

    const matched: ManifestOutput[] = [];
    for (const c of concepts) {
      for (const o of byConcept.get(c) ?? []) {
        if (!matched.includes(o)) matched.push(o);
      }
    }

    // Unmapped vocabulary falls to "manual" on purpose. The entry is on the
    // buyer's list, so the supplier must see it; the only question we cannot
    // answer yet is who supplies it, and "expect this, source unconfirmed" is
    // the honest under-claim. Suppressing it would recreate the original bug.
    let kind: ManifestKind = "manual";
    if (matched.length > 0) {
      kind = "app";
    } else if (concepts.length > 0 && concepts.every((c) => !conceptHasArtwork(c))) {
      // Every concept it names is a physical item — a hanger, a polybag, a
      // carton. Nothing will ever be "delivered" for this row, so it must not
      // sit at pending forever.
      kind = "info";
    }

    if (kind === "app") {
      for (const o of matched) claimed.add(o.variantKey);
      // A size only means something when ONE document answers the entry; two
      // documents of different sizes would print a single misleading size.
      const single = matched.length === 1 ? matched[0] : null;
      const suppliedAs = matched.map((o) => o.displayName);
      rows.push({
        displayName: label,
        sourceLabel: label,
        // Name the documents the supplier will actually receive, so the Monday
        // wording and the file they open can be reconciled. Dropped when the
        // single document is already called the same thing.
        ...(suppliedAs.length === 1 && normalizeTrimLabel(suppliedAs[0]) === normalizeTrimLabel(label)
          ? {}
          : { suppliedAs }),
        widthMm: single ? single.widthMm : null,
        heightMm: single ? single.heightMm : null,
        fileCount: single ? single.fileCount : null,
        approved: matched.every((o) => o.approved),
        kind: "app",
        ...copyField(resolveTrimCopy(concepts, conceptCopy)),
      });
      continue;
    }

    rows.push({
      displayName: label,
      sourceLabel: label,
      widthMm: null,
      heightMm: null,
      fileCount: null,
      // An info row has no delivery state at all — leaving `approved` undefined
      // is what keeps it out of the pending count and out of the status column.
      ...(kind === "manual" ? { approved: manualDelivered.has(normalizeTrimLabel(label)) } : {}),
      kind,
      ...copyField(resolveTrimCopy(concepts, conceptCopy)),
    });
  }

  // ---- Then everything we deliver that Monday never mentioned. Listing it is
  // the point: the supplier is receiving it either way, and a cover that hides
  // it is how the two lists silently drift apart.
  for (const o of outputs) {
    if (claimed.has(o.variantKey)) continue;
    rows.push({
      displayName: o.displayName,
      widthMm: o.widthMm,
      heightMm: o.heightMm,
      fileCount: o.fileCount,
      approved: o.approved,
      kind: "app",
      ...copyField(resolveTrimCopy(o.concept ? [o.concept] : [], conceptCopy)),
    });
  }

  return rows;
}

// Stable fingerprint of a manifest's PRINTED content.
//
// This is what makes a re-sweep a no-op instead of another few hundred uploads:
// a cover is only worth rebuilding when the page would actually read
// differently. Deliberately covers exactly the fields that reach paper — a
// change in the underlying variantKey that prints identically is not a reason
// to overwrite a supplier's file.
//
// JSON rather than a delimiter-joined string: a display name is free text that
// can contain any separator we might pick, and two different manifests running
// their fields together into one identical blob would silently skip a cover
// that DID change. JSON quoting makes that impossible.
export function manifestFingerprint(docs: ReadonlyArray<BundleDocSummary>): string {
  return JSON.stringify(
    docs.map((d) => [
      d.displayName,
      d.sourceLabel ?? null,
      d.suppliedAs ?? null,
      d.widthMm,
      d.heightMm,
      d.kind ?? "app",
      d.approved ?? null,
      // Appended ONLY when the row carries concept copy. An unconditional
      // element would shift every existing fingerprint and flag the whole
      // estate as changed on the day this shipped; a row that prints no note
      // reads exactly as it always did, so it must fingerprint that way too.
      ...(d.copy ? [d.copy] : []),
    ]),
  );
}
