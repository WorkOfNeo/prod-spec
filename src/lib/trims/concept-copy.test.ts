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
  normalizeCustomerCopy,
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
    // alwaysManual/printOnCover/customerCopy come off with the row-only fields:
    // they are stored per row and default to "changes nothing", so the seed
    // rows must carry them at exactly those values or the day-one no-op would
    // not hold.
    DEFAULT_TRIM_CONCEPT_ROWS.map(
      ({ sortOrder, builtIn, active, alwaysManual, printOnCover, customerCopy, ...c }) => {
        assert.equal(builtIn, true);
        assert.equal(active, true);
        assert.equal(alwaysManual, false, "nothing is supplied by hand by decree");
        assert.equal(printOnCover, true, "every seeded row prints");
        assert.deepEqual(customerCopy, [], "no client reads anything special out of the box");
        assert.equal(typeof sortOrder, "number");
        return c;
      },
    ),
    DEFAULT_TRIM_CONCEPTS,
  );
});

// ---------------------------------------------------------------------------
// PER-CUSTOMER STATUS WORDING.
//
// The thing these tests are really guarding is the boundary: exactly two
// sentences may vary by customer, everything else about a row stays global,
// and a row with no overrides must fingerprint byte-identically to what it did
// before the feature existed.
// ---------------------------------------------------------------------------

test("a named client reads its own status wording, everyone else reads the row's", () => {
  const map = conceptCopyFromRows([
    {
      value: "BANDEROLE",
      label: "Banderole",
      artwork: true,
      pending: "Awaiting Photo Samples from the supplier.",
      customerCopy: [
        { customerIds: ["cust_netto_de"], pending: "Foto af vare afventes", delivered: "Godkendt" },
      ],
    },
  ]);

  const netto = resolveTrimCopy(["BANDEROLE"], map, { customerId: "cust_netto_de" });
  assert.equal(netto?.pending, "Foto af vare afventes");
  assert.equal(netto?.delivered, "Godkendt");

  // Any other client, and a render with no client at all (the layout editor's
  // preview has no style behind it), read the row's own wording.
  assert.equal(
    resolveTrimCopy(["BANDEROLE"], map, { customerId: "cust_someone_else" })?.pending,
    "Awaiting Photo Samples from the supplier.",
  );
  assert.equal(resolveTrimCopy(["BANDEROLE"], map)?.pending, "Awaiting Photo Samples from the supplier.");
});

test("one entry covers several clients — the whole reason it is a list", () => {
  const map = conceptCopyFromRows([
    {
      value: "BANDEROLE",
      label: "Banderole",
      artwork: true,
      customerCopy: [{ customerIds: ["a", "b", "c"], pending: "Shared sentence" }],
    },
  ]);
  for (const id of ["a", "b", "c"]) {
    assert.equal(resolveTrimCopy(["BANDEROLE"], map, { customerId: id })?.pending, "Shared sentence");
  }
  assert.equal(resolveTrimCopy(["BANDEROLE"], map, { customerId: "d" }), undefined);
});

test("each box falls back on its own — half an override is not a blanking", () => {
  // Writing only "not yet delivered" must leave "delivered" reading the row's
  // wording. Blanking the other half would be the cover silently losing a word.
  const map = conceptCopyFromRows([
    {
      value: "BANDEROLE",
      label: "Banderole",
      artwork: true,
      pending: "Row pending",
      delivered: "Row delivered",
      customerCopy: [{ customerIds: ["x"], pending: "Client pending" }],
    },
  ]);
  const resolved = resolveTrimCopy(["BANDEROLE"], map, { customerId: "x" });
  assert.equal(resolved?.pending, "Client pending");
  assert.equal(resolved?.delivered, "Row delivered");
});

test("a packing instruction has no per-client wording either", () => {
  // The artwork:false guarantee is enforced on write, on read and at render.
  // This is the READ guard: a row hand-edited in SQL cannot smuggle a status
  // back in through the per-client column.
  const map = conceptCopyFromRows([
    {
      value: "POLYBAG",
      label: "Polybag",
      artwork: false,
      customerCopy: [{ customerIds: ["x"], pending: "Waiting", delivered: "Done" }],
    },
  ]);
  assert.equal(map.POLYBAG, undefined);
  assert.equal(resolveTrimCopy(["POLYBAG"], map, { customerId: "x" }), undefined);
});

test("the note never varies by client", () => {
  // A standing fact about how the artwork is BUILT does not change because of
  // who is buying it — and the override shape has no note field for a reason.
  const map = conceptCopyFromRows([
    {
      value: "CARE_LABEL",
      label: "Care label",
      artwork: true,
      note: "Printed on one paper, front and back",
      customerCopy: [{ customerIds: ["x"], pending: "Client pending" }],
    },
  ]);
  assert.equal(
    resolveTrimCopy(["CARE_LABEL"], map, { customerId: "x" })?.note,
    "Printed on one paper, front and back",
  );
});

test("a row with no overrides is byte-identical to the pre-override map", () => {
  // The sparseness rule, which is what keeps the estate out of a rebuild for
  // covers that read exactly the same.
  const withField = conceptCopyFromRows([
    { value: "HANGTAG", label: "Hangtag", artwork: true, pending: "Soon", customerCopy: [] },
  ]);
  const without = conceptCopyFromRows([
    { value: "HANGTAG", label: "Hangtag", artwork: true, pending: "Soon" },
  ]);
  assert.deepEqual(withField, without);
  assert.equal(JSON.stringify(withField), JSON.stringify(without));
  assert.ok(!("byCustomer" in withField.HANGTAG));
});

test("a client's sentence beats the row's even when a later concept carries it", () => {
  // A compound Monday entry ("Hanger & Hangtag") names two concepts and takes
  // the first with something to say. If the FIRST has only house wording and
  // the SECOND has this client's, the client's must still win: an override is
  // more specific than the row it overrides, and that has to hold across the
  // per-concept walk rather than only within one concept.
  const map = conceptCopyFromRows([
    { value: "FIRST", label: "First", artwork: true, pending: "Generic" },
    {
      value: "SECOND",
      label: "Second",
      artwork: true,
      customerCopy: [{ customerIds: ["x"], pending: "This client's words" }],
    },
  ]);
  assert.equal(
    resolveTrimCopy(["FIRST", "SECOND"], map, { customerId: "x" })?.pending,
    "This client's words",
  );
  // And a client with no override still gets the first-concept-wins rule that
  // has always applied.
  assert.equal(resolveTrimCopy(["FIRST", "SECOND"], map, { customerId: "y" })?.pending, "Generic");
  assert.equal(resolveTrimCopy(["FIRST", "SECOND"], map)?.pending, "Generic");
});

test("an override that says nothing is not stored — no empty husks", () => {
  // Three ways to say nothing, all dropped on write, because a stored husk
  // would move the row's fingerprint and sweep covers into a rebuild for a
  // page that reads identically.
  assert.deepEqual(normalizeCustomerCopy([{ customerIds: [], pending: "Words" }]), []);
  assert.deepEqual(normalizeCustomerCopy([{ customerIds: ["x"], pending: "  " }]), []);
  assert.deepEqual(normalizeCustomerCopy([{ customerIds: ["x"] }]), []);
  assert.deepEqual(normalizeCustomerCopy(null), []);
  assert.deepEqual(normalizeCustomerCopy("nonsense"), []);
});

test("a client named twice is claimed by the first entry only", () => {
  // resolveTrimCopy takes the first entry naming a client, so a second naming
  // would be wording visible in the editor that no cover will ever print. It
  // comes off the LATER entry, which survives for its other clients.
  const out = normalizeCustomerCopy([
    { customerIds: ["a", "b"], pending: "First" },
    { customerIds: ["b", "c"], pending: "Second" },
  ]);
  assert.deepEqual(out, [
    { customerIds: ["a", "b"], pending: "First" },
    { customerIds: ["c"], pending: "Second" },
  ]);
});

test("a later entry that loses its only client is dropped whole", () => {
  const out = normalizeCustomerCopy([
    { customerIds: ["a"], pending: "First" },
    { customerIds: ["a"], pending: "Shadowed" },
  ]);
  assert.deepEqual(out, [{ customerIds: ["a"], pending: "First" }]);
});

test("a packing instruction loses its per-client wording on write too", () => {
  // Guard #1 of the three (write / read / render) — the one that does not
  // depend on the editor.
  const [row] = normalizeTrimConceptRows([
    {
      value: "POLYBAG",
      label: "Polybag",
      artwork: false,
      customerCopy: [{ customerIds: ["x"], pending: "Waiting" }],
    },
  ]);
  assert.deepEqual(row.customerCopy, []);
});
