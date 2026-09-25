// =====================================================
// What the cover SAYS about a trim, keyed by CONCEPT.
//
// Three supplier-facing strings per concept, all columns on the packaging ROW
// (trim_concept_rows), edited at /settings/cover-page?tab=packaging:
//
//   note      — a standing fact about what this kind of document IS. "Wash Care
//               Label, these are created to be printed on one paper, front and
//               back" is true of every care label this app has ever produced,
//               for every customer, on every PO, because it describes how the
//               artwork is built. Not a status: it prints in every state.
//   pending   — the status wording while the artwork has not been delivered.
//               "Waiting for Customer Information" almost everywhere; a
//               banderole cannot be designed until the supplier sends photos of
//               the samples, so it says "Awaiting Photo Samples from the
//               supplier." and the supplier knows the ball is in their court.
//   delivered — the status wording once the artwork is confirmed.
//
// WHY IT HANGS OFF THE CONCEPT. The obvious home for these is the per-customer
// cover text block. That does not scale, for exactly the reason the concept
// layer exists at all (see concepts.ts): "Care Label" is a different layout for
// each customer, so a sentence about care labels would have to be typed into
// ~30 cover blocks, retyped for every customer taken on afterwards, and would
// drift out of step the first time one of them was edited. Said once against
// CARE_LABEL, it prints wherever a care label prints, forever.
//
// WHY IT IS DATA AND NOT AN `if`. The banderole rule is a seeded row column,
// not a branch in the renderer. The next special case — and there is always a
// next one — is then a settings edit rather than a deploy.
//
// WHY IT IS A COLUMN AND NOT A SECOND STORE. It used to live in its own
// AppSetting blob keyed by concept, which meant a row and the words it prints
// were added in two different places and could disagree about which concepts
// exist. The wording moves with the row: one table, one editor, one truth.
//
// artwork:false CONCEPTS NEVER GET A STATUS. A polybag, a hanger, a carton, a
// hook is a physical packing instruction with no file behind it (Master Polybag
// alone is on 1,733 styles). Giving one a delivered/not-delivered state would
// park it at "waiting" forever and bury the rows that genuinely are waiting.
// The guarantee is enforced three times over, because it only has to fail once
// to bury a queue:
//   1. on WRITE  — normalizeTrimConceptRows drops the status columns of any
//                  artwork:false row before it reaches the table,
//   2. on READ   — conceptCopyFromRows below strips them again, from the row's
//                  OWN flag, so a row edited by hand in SQL still cannot print
//                  a status,
//   3. at RENDER — resolveTrimCopy refuses to take a status from a concept
//                  without artwork, and the caller passes allowStatus:false for
//                  a manifest row that has no delivery state at all.
//
// CLIENT-SAFE: pure, no db, no server imports.
// =====================================================

import {
  conceptHasArtwork,
  customerTrimCopy,
  DEFAULT_TRIM_CONCEPTS,
  type TrimConcept,
} from "./concepts";

// The wording used when a concept says nothing of its own. These are the
// sentences covers have always printed, so an unconfigured estate reads exactly
// as it did before any of this existed.
export const DEFAULT_PENDING_STATUS = "Waiting for Customer Information";
export const DEFAULT_DELIVERED_STATUS = "Approved";

export type TrimConceptCopy = {
  // Plain text (escaped at render), not markdown — one line under the row.
  note?: string;
  // Status wording. Meaningless, and therefore removed, on an artwork:false
  // concept.
  pending?: string;
  delivered?: string;
  // PER-CUSTOMER status wording: customer id -> the sentences that customer
  // reads instead of the two above. Carried on the MAP rather than resolved
  // away when the map is built, because one loaded settings blob is threaded
  // across every style in a sweep and those styles belong to different
  // customers — baking one customer's answer into it would make the second
  // style print the first one's cover.
  //
  // Sparse, like every other field here: a concept with no overrides carries
  // no key, so its fingerprint is byte-identical to what it was before this
  // existed. The note is deliberately absent — a standing fact about how the
  // artwork is built does not change because of who is buying it.
  byCustomer?: Readonly<Record<string, { pending?: string; delivered?: string }>>;
};

export type TrimConceptCopyMap = Readonly<Record<string, TrimConceptCopy>>;

const FIELDS = ["note", "pending", "delivered"] as const;

// Rows -> the map the render chain uses.
//
// A field is carried only when the row has something to say, and a concept
// appears only when at least one field survived. That sparseness is load-bearing
// rather than tidy: resolveTrimCopy returns undefined for a concept with nothing
// to say, which leaves the `copy` key off the manifest row entirely, which is
// what keeps that row's fingerprint byte-identical to what it was before any of
// this existed. A map full of empty husks would sweep the whole estate into a
// rebuild for a cover that reads the same.
//
// The artwork flag is read from the ROW rather than from the loaded catalogue.
// The two agree in every normal path, but a caller building a map from rows it
// holds in hand — the settings preview, a test — must get the guarantee from
// the data it passed, not from whatever the process happens to have loaded.
export function conceptCopyFromRows(rows: ReadonlyArray<TrimConcept>): TrimConceptCopyMap {
  const out: Record<string, TrimConceptCopy> = {};
  for (const row of rows) {
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    if (!value) continue;
    const entry: TrimConceptCopy = {};
    for (const field of FIELDS) {
      // A packing instruction has no delivery state to describe.
      if (field !== "note" && !row.artwork) continue;
      const v = typeof row[field] === "string" ? (row[field] as string).trim() : "";
      if (v) entry[field] = v;
    }
    // The per-customer overrides, folded in AFTER the strip above so the
    // artwork:false guarantee covers them too — a hand-edited polybag row
    // carrying customer wording loses it here, not just on write.
    if (row.artwork && Array.isArray(row.customerCopy) && row.customerCopy.length > 0) {
      const byCustomer: Record<string, { pending?: string; delivered?: string }> = {};
      for (const override of row.customerCopy) {
        if (!Array.isArray(override?.customerIds)) continue;
        for (const id of override.customerIds) {
          // First entry naming a customer wins, matching customerTrimCopy.
          if (typeof id !== "string" || !id.trim() || byCustomer[id.trim()]) continue;
          const resolved = customerTrimCopy(row, id.trim());
          if (resolved) byCustomer[id.trim()] = resolved;
        }
      }
      if (Object.keys(byCustomer).length > 0) entry.byCustomer = byCustomer;
    }
    if (Object.keys(entry).length > 0) out[value] = entry;
  }
  return out;
}

// The seed copy, derived from the seed rows rather than restated. Everything
// absent here falls to the defaults above (statuses) or prints nothing (note).
export const DEFAULT_TRIM_CONCEPT_COPY: TrimConceptCopyMap =
  conceptCopyFromRows(DEFAULT_TRIM_CONCEPTS);

// The copy that applies to ONE manifest row, given the concepts that row
// resolves to (a compound Monday entry names several).
//
// Returns undefined rather than an empty object when nothing applies, so a row
// with no copy carries no field at all — the manifest fingerprint then stays
// byte-identical to what it was before this existed, and an estate whose covers
// gain nothing is not swept into a rebuild.
export type ResolvedTrimCopy = {
  note?: string;
  pending?: string;
  delivered?: string;
};

export function resolveTrimCopy(
  concepts: ReadonlyArray<string>,
  map: TrimConceptCopyMap = DEFAULT_TRIM_CONCEPT_COPY,
  opts?: {
    // false for a row with no delivery state — a packing instruction. The
    // guard at the ROW rather than at the concept, so a compound entry that
    // names a real document alongside a polybag still cannot borrow a status
    // from the polybag.
    allowStatus?: boolean;
    // WHOSE cover this is. When the concept has a sentence written for this
    // customer, it is taken instead of the row's own — but only for the field
    // it actually fills, so an override that sets "not yet delivered" alone
    // leaves "delivered" reading the row's wording rather than blanking it.
    //
    // Absent ⇒ the row's own wording throughout, which is every caller that
    // predates overrides and every render with no customer in hand (the layout
    // editor's preview has no style behind it).
    customerId?: string | null;
  },
): ResolvedTrimCopy | undefined {
  const allowStatus = opts?.allowStatus !== false;
  const customerId = opts?.customerId?.trim() || null;
  // Fixed key order, so two runs over the same input serialise identically into
  // the manifest fingerprint.
  const resolved: ResolvedTrimCopy = {};
  for (const field of FIELDS) {
    if (field !== "note" && !allowStatus) continue;
    // Statuses only ever come from a concept that HAS artwork; a note can come
    // from any of them.
    const usable = concepts.filter((c) => field === "note" || conceptHasArtwork(c));

    // TWO PASSES, AND THE ORDER OF THEM IS THE PRECEDENCE RULE.
    //
    // Within one pass, the first concept with something to say wins — a
    // compound Monday entry ("Hanger & Hangtag") is ONE row and can only print
    // one of each field, so it takes the first answer in the order the entry
    // named them. That is the rule this file has always had.
    //
    // What the customer pass adds is that an override outranks the row wording
    // ACROSS concepts, not merely within one. Take "Hanger & Hangtag" where
    // HANGER carries the house sentence and HANGTAG carries the one written
    // for this buyer: a single pass would print the house sentence, because
    // HANGER came first and had something to say. That is the wrong answer —
    // somebody deliberately wrote words for this client, and a generic
    // sentence that happened to be earlier in the list is not a reason to
    // ignore them. An override is by definition more specific than the thing
    // it overrides, so it is looked for everywhere before the fallback is
    // looked for anywhere.
    //
    // The note is never customer-specific (see TrimConceptCopy.byCustomer), so
    // it skips the first pass entirely.
    let value: string | undefined;
    if (field !== "note" && customerId) {
      for (const concept of usable) {
        const v = map[concept]?.byCustomer?.[customerId]?.[field]?.trim();
        if (v) {
          value = v;
          break;
        }
      }
    }
    if (!value) {
      for (const concept of usable) {
        const v = map[concept]?.[field]?.trim();
        if (v) {
          value = v;
          break;
        }
      }
    }
    if (value) resolved[field] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
