import { db } from "@/lib/db";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { eanResolveInputs } from "@/lib/po/resolve-inputs";

// =====================================================
// Lookalike style rows — "am I even looking at the right Monday row?"
//
// The single biggest source of "something's up with this style" support
// messages is NOT a broken style: it is a reviewer opening the WRONG ROW.
// Monday's Pre-Order board carries one row per (style × Purchase Order) and
// the style name is copied verbatim onto each of them, so C-PO63018 and
// C-PO63394 can both be called e.g. "IL62778I Fleece pants" while covering
// DIFFERENT parts of the size run (19-22 / 23-26 / … on one, 27-30 / 31-34 on
// the other). That is exactly the report we got: a reviewer saw 3 sizes where
// the operator expected 2. The row they opened was internally perfect —
// nothing missing, nothing errored, status green. No validation could ever
// have caught it, because nothing IS wrong; the reviewer was simply standing
// on the other PO's row.
//
// So everything here is a DIAGNOSTIC, never a validation: we find the other
// rows that plausibly describe the same product on a different PO and hand the
// UI enough context to say *why* it linked them, so a weak signal can't
// masquerade as a certainty.
//
// Deliberately NOT the same thing as the sibling pool in render-context.ts
// (buildStyleData's `loadSiblings`): that one is scoped to the SAME PO and
// exists solely to feed Custom Carton Marking. Same-name-same-PO rows are the
// carton case; same-name-DIFFERENT-PO rows are the mix-up case. Opposite
// filters, opposite purposes — keep them apart.
// =====================================================

// Match keys, strongest first. Order IS the confidence ranking: the index in
// this tuple is the confidence rank, so adding a weaker key means appending.
//
//  1. name             — the CONFIRMED real-world signal. Monday duplicates a
//                        Pre-Order row per PO and the name rides along byte
//                        for byte, so an exact hit is as strong as it gets.
//                        Backed by @@index([name]) on Style.
//  2. consignmentCode  — text99__1, the stable ingest-time article-group code
//                        ("ILC01989"). Survives a renamed row, but a whole
//                        article group can share one, so it's weaker.
//  3. customerItemNo   — text91__1. Weakest of the three: buyers reuse an
//                        article number across seasons and colourways.
export const LOOKALIKE_MATCH_KEYS = ["name", "consignmentCode", "customerItemNo"] as const;
export type LookalikeMatchKey = (typeof LOOKALIKE_MATCH_KEYS)[number];

// Human phrasing for the "why are these linked?" line. Plain data (no server
// imports) so the card can render it without pulling this module's DB half
// into a client bundle.
export const LOOKALIKE_MATCH_LABELS: Record<LookalikeMatchKey, string> = {
  name: "same style name",
  consignmentCode: "same consignment code",
  customerItemNo: "same customer article no.",
};

// 1 = strongest. Exposed as a number (rather than making callers re-derive it
// from the tuple) because the UI sorts on it and may want to gate on "only
// show me rank-1 matches" later.
export function lookalikeConfidence(key: LookalikeMatchKey): number {
  return LOOKALIKE_MATCH_KEYS.indexOf(key) + 1;
}

// The Style columns the matcher needs. Kept as a structural type — not a
// Prisma payload type — so the pure half below is testable with hand-written
// rows and never drags the client in.
export type LookalikeSourceRow = {
  id: string;
  name: string;
  poNumber: string | null;
  // The Monday column snapshot. Keys 2 and 3 live in here, not in columns.
  rawData: unknown;
  eanStatus: string;
  mondayItemId: string;
};

// One lookalike, as the UI consumes it.
export type LookalikeMatch = {
  id: string;
  name: string;
  poNumber: string | null;
  // The resolved size run — the field that actually differs between the two
  // rows in the reported mix-up, so it's the thing worth showing side by side.
  sizes: string[];
  eanStatus: string;
  mondayItemId: string;
  // Which key linked the rows, and how much that's worth. Both travel with the
  // match so the card can say "same consignment code" instead of implying an
  // identity it never established.
  matchedOn: LookalikeMatchKey;
  confidence: number;
};

// The subject row, resolved the same way its matches are — so the card can put
// "you are here" on a line that reads identically to the others.
export type LookalikeSubject = {
  id: string;
  name: string;
  poNumber: string | null;
  sizes: string[];
  eanStatus: string;
  mondayItemId: string;
};

export type LookalikeReport = {
  subject: LookalikeSubject;
  matches: LookalikeMatch[];
};

// Normalized PO identity. A lookalike is only interesting when it sits on a
// DIFFERENT PO — same name + same PO is the Custom Carton Marking sibling
// case, which is expected and already handled elsewhere. Two rows that both
// lack a PO count as "same" (neither is the other's other-order twin).
function poKey(po: string | null): string {
  return (po ?? "").trim().toUpperCase();
}

// Exact name equality — deliberately NOT trimmed or case-folded.
//
// Two reasons, and they point the same way. (a) The signal we confirmed is a
// Monday row DUPLICATED per PO, so the names are byte-identical; loosening the
// comparison buys nothing real and starts pulling in genuinely different
// styles that happen to differ only in case. (b) The lookup is served by a
// plain btree @@index([name]); lower()/trim() on either side would stop the
// planner using it, and the bulk list query below has to stay index-only to be
// safe on every render. Keeping the SQL and the in-memory predicate literally
// the same comparison also means the list chip's count can never disagree with
// the detail card's list.
function sameName(a: string, b: string): boolean {
  return a === b && a.trim().length > 0;
}

// The three comparable values for one row. The NAME key is the literal
// Style.name — the Monday row title that gets duplicated per PO — NOT
// eanResolveInputs' styleNumber, which falls back to the name but prefers a
// mapped style-number column that may carry something else entirely. The other
// two come straight off the resolved inputs.
type LookalikeKeys = { name: string; consignmentCode: string; customerItemNo: string };

// One pass over a row's Monday snapshot yields BOTH the match keys and the
// size run — the snapshot walk is the only real cost here and there is no
// reason to pay it twice per candidate.
function resolveRow(
  row: LookalikeSourceRow,
  mapping: ColumnMapping,
): LookalikeKeys & { sizes: string[] } {
  const resolved = eanResolveInputs(row.rawData, mapping, row.name, row.poNumber);
  return {
    name: row.name,
    consignmentCode: resolved.consignmentCode,
    customerItemNo: resolved.customerItemNo,
    sizes: resolved.sizes,
  };
}

// Which key (if any) links `candidate` to `subject`, strongest first. Returns
// null when nothing links them. Keys 2 and 3 only count when non-empty —
// otherwise every row with a blank consignment code would "match" every other.
function matchKeyFor(subject: LookalikeKeys, candidate: LookalikeKeys): LookalikeMatchKey | null {
  if (sameName(subject.name, candidate.name)) return "name";
  if (subject.consignmentCode && subject.consignmentCode === candidate.consignmentCode) {
    return "consignmentCode";
  }
  if (subject.customerItemNo && subject.customerItemNo === candidate.customerItemNo) {
    return "customerItemNo";
  }
  return null;
}

// ── Pure matching / ranking ────────────────────────────────────────────────
// The whole decision procedure, as a function over rows. No DB, no Prisma
// types, no I/O — the loaders below are thin shells that fetch a bounded
// candidate set and call this. Unit-tested in related.test.ts.
//
// `mapping` is the customer's column mapping; both sides are read through
// eanResolveInputs so the consignment code / customer item no / size run are
// resolved under the EXACT mapping the PDF mapper and the EAN resolver use
// (ProdSpec override → Customer config → defaults, with the manual.* fallback).
// Re-deriving those reads here would be a second source of truth that silently
// drifts the first time a customer remaps a column.
export function findLookalikes(
  subject: LookalikeSourceRow,
  candidates: readonly LookalikeSourceRow[],
  mapping: ColumnMapping,
): LookalikeMatch[] {
  const subjectKeys = resolveRow(subject, mapping);
  const subjectPo = poKey(subject.poNumber);

  const matches: LookalikeMatch[] = [];
  const seen = new Set<string>([subject.id]);

  for (const c of candidates) {
    // Exclude self, and de-dupe: the loader unions two candidate reads (the
    // indexed name hit + the bounded same-customer window), which overlap.
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    // Same PO ⇒ not a lookalike, whatever else matches.
    if (poKey(c.poNumber) === subjectPo) continue;

    const resolved = resolveRow(c, mapping);
    const matchedOn = matchKeyFor(subjectKeys, resolved);
    if (!matchedOn) continue;

    matches.push({
      id: c.id,
      name: c.name,
      poNumber: c.poNumber,
      sizes: resolved.sizes,
      eanStatus: c.eanStatus,
      mondayItemId: c.mondayItemId,
      matchedOn,
      confidence: lookalikeConfidence(matchedOn),
    });
  }

  // Strongest first, then by PO so the list reads like an order sequence
  // (C-PO63018 before C-PO63394) rather than in query order.
  return matches.sort(
    (a, b) =>
      a.confidence - b.confidence ||
      poKey(a.poNumber).localeCompare(poKey(b.poNumber)) ||
      a.id.localeCompare(b.id),
  );
}

// ── DB shells ──────────────────────────────────────────────────────────────

// The Style columns every lookalike read projects. rawData is the expensive
// one (a full Monday column snapshot, single-digit KB per row) and is the
// reason the same-customer pass below is bounded rather than open-ended.
const LOOKALIKE_SELECT = {
  id: true,
  name: true,
  poNumber: true,
  rawData: true,
  eanStatus: true,
  mondayItemId: true,
} as const;

// How many same-name rows the indexed pass will take. A style duplicated once
// per PO realistically tops out in the low single digits; 25 is "we will never
// truncate a real case" while still capping the blast radius if a placeholder
// name ("TEST", "") ever gets copied across hundreds of rows.
export const LOOKALIKE_NAME_LIMIT = 25;

// How many same-customer rows the JSON pass will look at.
//
// Keys 2 and 3 live INSIDE Style.rawData, so there is no index to hit and no
// way to express them as a where-clause — they can only be filtered in memory,
// which means the candidate set has to be constrained in SQL first. The bound
// is: same customer (a consignment code / customer article no. is only ever
// meaningful within one customer's numbering), not archived, not deleted,
// newest-updated first, capped at 200 rows. That is a couple of MB of snapshot
// JSON worst case and it is paid ONCE per style-detail render — never per list
// row (the list uses loadLookalikeChips below, which never touches rawData).
//
// The cap is safe to truncate against precisely because it only gates the WEAK
// keys: the exact-name pass is a separate, indexed, non-truncating query, so
// the confirmed real-world signal is always found in full no matter how many
// styles a customer has.
export const LOOKALIKE_CANDIDATE_LIMIT = 200;

// Full lookalike report for ONE style — the style-detail card's loader.
// Returns null when the style doesn't exist (deleted mid-navigation).
export async function loadLookalikes(styleId: string): Promise<LookalikeReport | null> {
  const subject = await db.style.findUnique({
    where: { id: styleId },
    select: { ...LOOKALIKE_SELECT, customerId: true, customer: { select: { config: true } } },
  });
  if (!subject) return null;

  const mapping: ColumnMapping = parseCustomerConfig(subject.customer.config).columnMapping;

  // Two reads, one round trip. They overlap freely — findLookalikes de-dupes.
  //   1. Exact name, indexed, unbounded by recency: the strong signal is never
  //      missed because the other PO's row happens to be old.
  //   2. A bounded recent window of the same customer, for the two JSON-only
  //      keys. See LOOKALIKE_CANDIDATE_LIMIT for why it's bounded and why
  //      truncating it is acceptable.
  // Archived / deleted rows are excluded on both: the app never hard-deletes
  // (see the Style model's soft-lifecycle comments), so a row Monday archived
  // is gone as far as a reviewer is concerned and must not be offered as a
  // "maybe you meant this one".
  const [byName, sameCustomer] = await Promise.all([
    subject.name.trim().length > 0
      ? db.style.findMany({
          where: {
            id: { not: subject.id },
            name: subject.name,
            archivedAt: null,
            deletedAt: null,
          },
          select: LOOKALIKE_SELECT,
          take: LOOKALIKE_NAME_LIMIT,
        })
      : Promise.resolve([]),
    db.style.findMany({
      where: {
        id: { not: subject.id },
        customerId: subject.customerId,
        archivedAt: null,
        deletedAt: null,
      },
      select: LOOKALIKE_SELECT,
      orderBy: { updatedAt: "desc" },
      take: LOOKALIKE_CANDIDATE_LIMIT,
    }),
  ]);

  const subjectSizes = eanResolveInputs(
    subject.rawData,
    mapping,
    subject.name,
    subject.poNumber,
  ).sizes;

  return {
    subject: {
      id: subject.id,
      name: subject.name,
      poNumber: subject.poNumber,
      sizes: subjectSizes,
      eanStatus: subject.eanStatus,
      mondayItemId: subject.mondayItemId,
    },
    matches: findLookalikes(subject, [...byName, ...sameCustomer], mapping),
  };
}

// ── Bulk entry point for the /styles list ──────────────────────────────────

// The minimum a row needs to be counted. Matches what the list already holds,
// so the list page passes its own rows straight in.
export type LookalikeChipRow = {
  id: string;
  name: string;
  poNumber: string | null;
};

// What the list chip renders: "1 of 2 rows with this name".
export type LookalikeChip = {
  // 1-based position of THIS row among the rows sharing its name, ordered by
  // PO — the "1". Stable across renders because the ordering is (PO, id), not
  // query order.
  position: number;
  // How many rows share the name, INCLUDING this one — the "2".
  total: number;
  // The other rows' POs, for the chip's hover title. Nulls are rendered as
  // "no PO" here rather than dropped, so the count in the title always adds up
  // to `total`.
  otherPoNumbers: string[];
};

// Pure half of the bulk path. `rows` is every non-archived row whose name is
// one of the subjects' names (i.e. the subjects themselves plus their
// name-twins). Only subjects that actually have a twin ON ANOTHER PO get an
// entry — the chip must be invisible in the common case, so "no entry" is the
// normal outcome and the caller renders nothing.
//
// NOTE this is the exact-name key only. The two JSON keys are unavailable here
// by construction: they'd need Style.rawData for every row on the page, which
// is precisely the N+1-shaped cost the list must not pay. The list chip is
// therefore the strong signal alone — which is also the one that caused the
// reported incident — and the detail card is where the weaker keys surface.
export function buildLookalikeChips(
  subjects: ReadonlyArray<LookalikeChipRow>,
  rows: ReadonlyArray<LookalikeChipRow>,
): Map<string, LookalikeChip> {
  const byName = new Map<string, LookalikeChipRow[]>();
  for (const r of rows) {
    if (r.name.trim().length === 0) continue;
    const group = byName.get(r.name);
    if (group) group.push(r);
    else byName.set(r.name, [r]);
  }

  const chips = new Map<string, LookalikeChip>();
  for (const subject of subjects) {
    if (subject.name.trim().length === 0) continue;
    let group = byName.get(subject.name) ?? [];
    // The subject is normally IN its own group (it's a row like any other),
    // but a subject that is itself archived won't come back from the query
    // that built `rows`. Fold it in so its position/total stay honest instead
    // of silently reporting the group as one short.
    if (!group.some((r) => r.id === subject.id)) group = [...group, subject];
    if (group.length < 2) continue;

    const others = group.filter((r) => r.id !== subject.id);
    // Same name on the SAME PO is a carton sibling, not a mix-up risk. Only
    // flag the row when at least one twin sits on a different order.
    const subjectPo = poKey(subject.poNumber);
    if (!others.some((r) => poKey(r.poNumber) !== subjectPo)) continue;

    const ordered = [...group].sort(
      (a, b) => poKey(a.poNumber).localeCompare(poKey(b.poNumber)) || a.id.localeCompare(b.id),
    );
    chips.set(subject.id, {
      position: ordered.findIndex((r) => r.id === subject.id) + 1,
      total: ordered.length,
      otherPoNumbers: ordered
        .filter((r) => r.id !== subject.id)
        .map((r) => r.poNumber?.trim() || "no PO"),
    });
  }
  return chips;
}

// ONE query for a whole page of styles — no N+1, no per-row work.
//
// Shape: a single indexed `name IN (…)` read projecting three small scalar
// columns and NO rawData. For the /styles list that is ~4k rows of a cuid + a
// name + a PO — a few hundred KB, and noise next to the query that page
// already runs (the same ~4k styles WITH their full Monday snapshots). One
// round trip regardless of how many rows are on the page, which is the point:
// the chip has to survive being on every row of the list.
//
// A groupBy on name would return less (one row per distinct name), but only a
// count — not the subject's position within the group, and not the twin's PO
// for the hover title. Both matter here: "1 of 2" plus "the other one is
// C-PO63394" is what actually redirects someone mid-search, where a bare "2"
// mostly raises a question. The extra bytes buy that, and the query cost is
// identical (same index, same predicate).
export async function loadLookalikeChips(
  subjects: ReadonlyArray<LookalikeChipRow>,
): Promise<Map<string, LookalikeChip>> {
  const names = [...new Set(subjects.map((s) => s.name).filter((n) => n.trim().length > 0))];
  if (names.length === 0) return new Map();

  const rows = await db.style.findMany({
    where: { name: { in: names }, archivedAt: null, deletedAt: null },
    select: { id: true, name: true, poNumber: true },
  });
  return buildLookalikeChips(subjects, rows);
}
