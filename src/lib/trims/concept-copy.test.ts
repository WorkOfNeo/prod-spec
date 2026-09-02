import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DELIVERED_STATUS,
  DEFAULT_PENDING_STATUS,
  DEFAULT_TRIM_CONCEPT_COPY,
  effectiveConceptCopy,
  normalizeConceptCopy,
  resolveTrimCopy,
} from "./concept-copy";
import { conceptHasArtwork, DEFAULT_TRIM_CONCEPTS } from "./concepts";

// The two sentences that were hardcoded before this existed. They are pinned
// here so a "tidy-up" of the defaults cannot quietly change what suppliers read.
test("the house defaults are the wording covers have always printed", () => {
  assert.equal(DEFAULT_PENDING_STATUS, "Waiting for Customer Information");
  assert.equal(DEFAULT_DELIVERED_STATUS, "Approved");
});

test("a banderole waits on the supplier's photos, and says so verbatim", () => {
  // A banderole cannot be designed until the supplier photographs the samples,
  // so pointing the supplier at the customer is pointing at the wrong party.
  // This is STORED DATA, not a branch in the renderer — which is the whole
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
// to survive a hand-rolled PUT, a compound trim entry, and a future editor.

test("a packing-instruction concept cannot be given a status, however it is stored", () => {
  const stored = normalizeConceptCopy({
    POLYBAG: { note: "Clear, 40 micron.", pending: "Waiting", delivered: "Received" },
    HANGER: { pending: "Waiting" },
    BOX: { delivered: "Received" },
    HOOK: { pending: "Waiting", note: "Black." },
    PACKING_NOTE: { pending: "Waiting" },
  });
  assert.deepEqual(stored.POLYBAG, { note: "Clear, 40 micron." });
  assert.deepEqual(stored.HOOK, { note: "Black." });
  // Nothing left to store at all ⇒ no entry, rather than an empty husk.
  assert.equal(stored.HANGER, undefined);
  assert.equal(stored.BOX, undefined);
  assert.equal(stored.PACKING_NOTE, undefined);
});

test("every artwork:false concept in the catalogue is status-proof", () => {
  // Pinned over the whole catalogue rather than a sample, so a concept added
  // later with artwork:false inherits the guarantee instead of needing a test.
  for (const concept of DEFAULT_TRIM_CONCEPTS.filter((c) => !c.artwork)) {
    const stored = normalizeConceptCopy({
      [concept.value]: { pending: "Waiting", delivered: "Received", note: "A note." },
    });
    assert.deepEqual(
      stored[concept.value],
      { note: "A note." },
      `${concept.value} must keep the note and lose the status`,
    );
    const resolved = resolveTrimCopy([concept.value], effectiveConceptCopy(stored));
    assert.equal(resolved?.pending, undefined, `${concept.value} must resolve no pending wording`);
    assert.equal(resolved?.delivered, undefined, `${concept.value} must resolve no delivered wording`);
  }
});

test("a row with no delivery state takes the note and none of the wording", () => {
  // The second guard, at the ROW rather than at the concept: an "info" row is
  // one whose every concept is a physical item, and it must not borrow status
  // wording from any of them.
  const map = effectiveConceptCopy({ CARE_LABEL: { pending: "Still coming" } });
  const resolved = resolveTrimCopy(["POLYBAG", "CARE_LABEL"], map, { allowStatus: false });
  assert.equal(resolved?.note?.startsWith("Wash Care Label"), true);
  assert.equal(resolved?.pending, undefined);
});

test("a compound entry cannot borrow a status from its packing-instruction half", () => {
  // "Polybag + Hangtag" is one row with two concepts. Even with the polybag
  // listed first — and even if something had smuggled wording onto it — the
  // status can only come from the concept that HAS artwork.
  const map = { ...effectiveConceptCopy(null), POLYBAG: { pending: "Polybag waiting" } };
  const resolved = resolveTrimCopy(["POLYBAG", "BANDEROLE"], map);
  assert.equal(resolved?.pending, "Awaiting Photo Samples from the supplier.");
});

// ---- Storage semantics -----------------------------------------------------

test("stored wording lays over the seeded defaults field by field", () => {
  // Setting a banderole NOTE must not silently drop its seeded pending wording.
  const map = effectiveConceptCopy({ BANDEROLE: { note: "Printed on 250g board." } });
  assert.equal(map.BANDEROLE?.note, "Printed on 250g board.");
  assert.equal(map.BANDEROLE?.pending, "Awaiting Photo Samples from the supplier.");
});

test("an empty string is how a seeded default is cleared, and it round-trips", () => {
  const stored = normalizeConceptCopy({ BANDEROLE: { pending: "" } });
  assert.equal(stored.BANDEROLE?.pending, "", "the empty string must survive normalisation");
  const map = effectiveConceptCopy(stored);
  assert.equal(map.BANDEROLE?.pending, "");
  // …and resolves to nothing, so the render falls back to the house default.
  assert.equal(resolveTrimCopy(["BANDEROLE"], map)?.pending, undefined);
});

test("junk in the stored blob is dropped rather than printed", () => {
  const stored = normalizeConceptCopy({
    CARE_LABEL: { note: 42, pending: null, colour: "red" },
    "": { note: "orphan" },
    HANGTAG: "not an object",
    BANDEROLE: ["nope"],
  });
  assert.deepEqual(stored, {});
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
  // exists to fix.
  assert.equal(conceptHasArtwork("SOMETHING_NEW"), true);
  const map = effectiveConceptCopy({ SOMETHING_NEW: { pending: "Coming" } });
  assert.equal(resolveTrimCopy(["SOMETHING_NEW"], map)?.pending, "Coming");
});
