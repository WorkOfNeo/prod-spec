import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DELIVERED_STATUS,
  DEFAULT_PENDING_STATUS,
  DEFAULT_TRIM_CONCEPT_COPY,
  conceptCopyFromRows,
  resolveTrimCopy,
} from "./concept-copy";
import {
  conceptHasArtwork,
  normalizeTrimConceptRows,
  setTrimConceptCatalogue,
  resetTrimConceptCatalogue,
  DEFAULT_TRIM_CONCEPTS,
  DEFAULT_TRIM_CONCEPT_ROWS,
} from "./concepts";

// The two sentences that were hardcoded before this existed. They are pinned
// here so a "tidy-up" of the defaults cannot quietly change what suppliers read.
test("the house defaults are the wording covers have always printed", () => {
  assert.equal(DEFAULT_PENDING_STATUS, "Waiting for Customer Information");
  assert.equal(DEFAULT_DELIVERED_STATUS, "Approved");
});

test("a banderole waits on the supplier's photos, and says so verbatim", () => {
  // A banderole cannot be designed until the supplier photographs the samples,
  // so pointing the supplier at the customer is pointing at the wrong party.
  // This is a ROW COLUMN, not a branch in the renderer — which is the whole
  // point: the next special case is a settings edit, not a deploy.
  assert.equal(
    DEFAULT_TRIM_CONCEPT_COPY.BANDEROLE?.pending,
    "Awaiting Photo Samples from the supplier.",
  );
  const resolved = resolveTrimCopy(["BANDEROLE"]);
  assert.equal(resolved?.pending, "Awaiting Photo Samples from the supplier.");
});

test("a care label carries its standing note, and it is not a status", () => {
  const resolved = resolveTrimCopy(["CARE_LABEL"]);
  assert.equal(
    resolved?.note,
    "Wash Care Label, these are created to be printed on one paper, front and back",
  );
  assert.equal(resolved?.pending, undefined);
  assert.equal(resolved?.delivered, undefined);
});

// ---- THE artwork:false GUARANTEE -------------------------------------------
//
// Polybags, hangers, cartons and hooks are physical packing instructions with
// no file behind them — Master Polybag alone is on 1,733 styles. A delivery
// status would park every one of them at "waiting" forever and bury the rows
// that genuinely are waiting. They print as a note with no status, and that has
// to survive a hand-rolled PUT, a compound trim entry, a future editor — and
// now the catalogue being a table anyone can add to.

test("a packing-instruction row cannot be given a status, however it is stored", () => {
  // Guard #1: on the way IN. Storage strips what a packing instruction must
  // never print, so no later reader has to remember the rule.
  const stored = normalizeTrimConceptRows([
    {
      value: "POLYBAG",
      label: "Polybag",
      artwork: false,
      note: "Clear, 40 micron.",
      pending: "Waiting",
      delivered: "Received",
    },
    { value: "HANGER", label: "Hanger", artwork: false, pending: "Waiting" },
    { value: "BOX", label: "Box", artwork: false, delivered: "Received" },
    { value: "HOOK", label: "Hook", artwork: false, pending: "Waiting", note: "Black." },
    { value: "PACKING_NOTE", label: "Packing instruction", artwork: false, pending: "Waiting" },
  ]);
  const byValue = new Map(stored.map((r) => [r.value, r]));
  assert.equal(byValue.get("POLYBAG")?.note, "Clear, 40 micron.");
  assert.equal(byValue.get("POLYBAG")?.pending, undefined);
  assert.equal(byValue.get("POLYBAG")?.delivered, undefined);
  assert.equal(byValue.get("HOOK")?.note, "Black.");
  assert.equal(byValue.get("HANGER")?.pending, undefined);
  assert.equal(byValue.get("BOX")?.delivered, undefined);
  assert.equal(byValue.get("PACKING_NOTE")?.pending, undefined);
  // Nothing left to say at all ⇒ no entry in the copy map, rather than an empty
  // husk that would shift every manifest fingerprint.
  const copy = conceptCopyFromRows(stored);
  assert.deepEqual(copy.POLYBAG, { note: "Clear, 40 micron." });
  assert.equal(copy.HANGER, undefined);
  assert.equal(copy.BOX, undefined);
  assert.equal(copy.PACKING_NOTE, undefined);
});

test("every artwork:false row in the catalogue is status-proof", () => {
  // Pinned over the WHOLE catalogue rather than a sample, so a row added later
  // with artwork:false inherits the guarantee instead of needing a test. The
  // catalogue is a table now, so the loop runs over rows in the shape the table
  // hands back — which is the path that actually reaches a cover.
  for (const row of DEFAULT_TRIM_CONCEPT_ROWS.filter((c) => !c.artwork)) {
    const stored = normalizeTrimConceptRows([
      { ...row, pending: "Waiting", delivered: "Received", note: "A note." },
    ]);
    assert.deepEqual(
      conceptCopyFromRows(stored)[row.value],
      { note: "A note." },
      `${row.value} must keep the note and lose the status`,
    );
    const resolved = resolveTrimCopy([row.value], conceptCopyFromRows(stored));
    assert.equal(resolved?.pending, undefined, `${row.value} must resolve no pending wording`);
    assert.equal(resolved?.delivered, undefined, `${row.value} must resolve no delivered wording`);
  }
});

test("a row added by a person is status-proof the moment it is saved", () => {
  // The guarantee cannot be a property of the twenty-one seeded rows. A row
  // Niels adds tomorrow and ticks "packing instruction" on gets it too, from
  // the same normaliser, with nothing added anywhere.
  const stored = normalizeTrimConceptRows([
    {
      value: "SILICA_SACHET",
      label: "Silica sachet",
      artwork: false,
      note: "One per polybag.",
      pending: "Waiting for Customer Information",
      delivered: "Approved",
    },
  ]);
  assert.deepEqual(conceptCopyFromRows(stored).SILICA_SACHET, { note: "One per polybag." });
});

test("the guarantee reads the ROW's own flag, not the loaded catalogue", () => {
  // Guard #2: on the way OUT. A caller holding rows in hand — a preview, a
  // test, a migration script — gets the answer from the data it passed, not
  // from whatever the process happens to have loaded, so the two can never
  // disagree about which rows are documents.
  try {
    setTrimConceptCatalogue([{ value: "POLYBAG", label: "Polybag", artwork: true }]);
    const copy = conceptCopyFromRows([
      { value: "POLYBAG", label: "Polybag", artwork: false, pending: "Waiting" },
    ]);
    assert.equal(copy.POLYBAG, undefined);
  } finally {
    resetTrimConceptCatalogue();
  }
});

test("a row with no delivery state takes the note and none of the wording", () => {
  // Guard #3, at the manifest ROW rather than at the concept: an "info" row is
  // one whose every concept is a physical item, and it must not borrow status
  // wording from any of them.
  const map = conceptCopyFromRows([
    { value: "CARE_LABEL", label: "Care label", artwork: true, ...DEFAULT_TRIM_CONCEPT_COPY.CARE_LABEL, pending: "Still coming" },
  ]);
  const resolved = resolveTrimCopy(["POLYBAG", "CARE_LABEL"], map, { allowStatus: false });
  assert.equal(resolved?.note?.startsWith("Wash Care Label"), true);
  assert.equal(resolved?.pending, undefined);
});

test("a compound entry cannot borrow a status from its packing-instruction half", () => {
  // "Polybag + Hangtag" is one row with two concepts. Even with the polybag
  // listed first — and even if something had smuggled wording onto it — the
  // status can only come from the concept that HAS artwork.
  const map = { ...DEFAULT_TRIM_CONCEPT_COPY, POLYBAG: { pending: "Polybag waiting" } };
  const resolved = resolveTrimCopy(["POLYBAG", "BANDEROLE"], map);
  assert.equal(resolved?.pending, "Awaiting Photo Samples from the supplier.");
});

// ---- Storage semantics -----------------------------------------------------

test("the wording travels with the row, field by field", () => {
  // Editing a banderole's NOTE must not silently drop its pending wording —
  // they are separate columns on one row rather than a blob laid over a
  // default, which is precisely why they can no longer disagree.
  const rows = normalizeTrimConceptRows([
    {
      value: "BANDEROLE",
      label: "Banderole",
      artwork: true,
      note: "Printed on 250g board.",
      pending: "Awaiting Photo Samples from the supplier.",
    },
  ]);
  const map = conceptCopyFromRows(rows);
  assert.equal(map.BANDEROLE?.note, "Printed on 250g board.");
  assert.equal(map.BANDEROLE?.pending, "Awaiting Photo Samples from the supplier.");
});

test("an emptied box is how a wording is cleared, and the row survives it", () => {
  const rows = normalizeTrimConceptRows([
    { value: "BANDEROLE", label: "Banderole", artwork: true, pending: "   " },
  ]);
  assert.equal(rows[0].pending, undefined, "whitespace is not wording");
  const map = conceptCopyFromRows(rows);
  assert.equal(map.BANDEROLE, undefined);
  // …and resolves to nothing, so the render falls back to the house default.
  assert.equal(resolveTrimCopy(["BANDEROLE"], map)?.pending, undefined);
});

test("junk in a stored row is dropped rather than printed", () => {
  const rows = normalizeTrimConceptRows([
    { value: "CARE_LABEL", label: "Care label", artwork: true, note: 42 as unknown as string },
    { value: "", label: "orphan", artwork: true },
    { value: "NO_LABEL", label: "   ", artwork: true },
    // A duplicate keeps the FIRST occurrence: silently keeping the last would
    // make an accidental duplicate overwrite the row a person was editing.
    { value: "CARE_LABEL", label: "Second care label", artwork: false },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].label, "Care label");
  assert.equal(rows[0].note, undefined);
  assert.equal(rows[0].artwork, true);
  assert.deepEqual(conceptCopyFromRows(rows), {});
});

test("a concept nobody configured leaves the row without copy at all", () => {
  // Not an empty object: the KEY has to be absent, because that is what keeps
  // such a row's manifest fingerprint identical to what it was before concept
  // copy existed.
  assert.equal(resolveTrimCopy(["CARTON_MARKING"]), undefined);
  assert.equal(resolveTrimCopy([]), undefined);
});

test("an unknown concept is treated as artwork, the safe direction", () => {
  // Mirrors conceptHasArtwork: mislabelling a real document as a packing note
  // would drop it from the manifest, which is the failure this whole feature
  // exists to fix. Now also the answer for a value naming a row that has since
  // been removed.
  assert.equal(conceptHasArtwork("SOMETHING_NEW"), true);
  const map = conceptCopyFromRows([
    { value: "SOMETHING_NEW", label: "Something new", artwork: true, pending: "Coming" },
  ]);
  assert.equal(resolveTrimCopy(["SOMETHING_NEW"], map)?.pending, "Coming");
});

test("the seed rows and the seed concept list are the same list", () => {
  // The rows the loader falls back to must be the concepts the rest of the app
  // was written against, or the fallback would be a second, subtly different
  // catalogue.
  assert.deepEqual(
    DEFAULT_TRIM_CONCEPT_ROWS.map(({ sortOrder, builtIn, active, ...c }) => {
      assert.equal(builtIn, true);
      assert.equal(active, true);
      assert.equal(typeof sortOrder, "number");
      return c;
    }),
    DEFAULT_TRIM_CONCEPTS,
  );
});
