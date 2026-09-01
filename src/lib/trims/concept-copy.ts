// =====================================================
// What the cover SAYS about a trim, keyed by CONCEPT.
//
// Some sentences on a cover are facts about the document itself rather than
// about one customer, one order or one supplier. "Wash Care Label, these are
// created to be printed on one paper, front and back" is true of every care
// label this app has ever produced — for every customer, on every PO — because
// it describes how the artwork is built, not what a particular buyer wants
// said.
//
// WHY IT HANGS OFF THE CONCEPT. The obvious home for a sentence like that is
// the per-customer cover text block. That does not scale for exactly the reason
// the concept layer exists at all (see concepts.ts): "Care Label" is a
// different layout for each customer, so the note would have to be typed into
// ~30 cover blocks and re-typed for every customer taken on afterwards — and it
// would drift out of step the first time one of them was edited. Stated once
// against CARE_LABEL, it prints wherever a care label prints, forever.
//
// The note is NOT a status. It is as true of a delivered care label as of one
// still waiting, so it prints in every state, under the row it belongs to.
//
// CLIENT-SAFE: pure, no db, no server imports.
// =====================================================

export type TrimConceptCopy = {
  // A standing fact about what this kind of document IS. Plain text (escaped at
  // render), not markdown — it prints as one line under the manifest row.
  note?: string;
};

export type TrimConceptCopyMap = Readonly<Record<string, TrimConceptCopy>>;

// The seed copy. Keyed by TrimConcept.value.
export const DEFAULT_TRIM_CONCEPT_COPY: TrimConceptCopyMap = {
  CARE_LABEL: {
    note: "Wash Care Label, these are created to be printed on one paper, front and back",
  },
};

// The copy that applies to ONE manifest row, given the concepts that row
// resolves to (a compound Monday entry names several).
//
// Returns undefined rather than an empty object when nothing applies, so a row
// with no copy carries no field at all — the manifest fingerprint then stays
// byte-identical to what it was before this existed, and an estate whose covers
// gain nothing is not swept into a rebuild.
export type ResolvedTrimCopy = {
  note?: string;
};

export function resolveTrimCopy(
  concepts: ReadonlyArray<string>,
  map: TrimConceptCopyMap = DEFAULT_TRIM_CONCEPT_COPY,
): ResolvedTrimCopy | undefined {
  // First concept that has something to say wins. A compound entry
  // ("Hangtag + Banderole") is one row and can only carry one note; taking the
  // first keeps it in the order the entry itself names them.
  for (const concept of concepts) {
    const note = map[concept]?.note?.trim();
    if (note) return { note };
  }
  return undefined;
}
