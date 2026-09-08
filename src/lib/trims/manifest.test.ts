import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIM_RULES, splitTrimsCell } from "./classify";
import { conceptCopyFromRows } from "./concept-copy";
import {
  DEFAULT_TRIM_CONCEPTS,
  normalizeTrimConceptRows,
  resetTrimConceptCatalogue,
  setTrimConceptCatalogue,
  type TrimConcept,
} from "./concepts";
import {
  assembleTrimManifest,
  manifestFingerprint,
  strongestKind,
  type ManifestOutput,
} from "./manifest";

const RULES = DEFAULT_TRIM_RULES;

const output = (over: Partial<ManifestOutput> & Pick<ManifestOutput, "variantKey" | "displayName" | "concept">): ManifestOutput => ({
  widthMm: 25,
  heightMm: 120,
  fileCount: 1,
  approved: false,
  ...over,
});

// The shape of the style from the ticket: 8 Monday trims against 3
// declared outputs, of which the cover printed one.
const TICKET_TRIMS = [
  "Main label with size",
  "Wash Care Label with Oeko-tex Logo",
  "Hangtag",
  "Barcode sticker",
  "Black Hanger",
  "Master Polybag",
  "Carton Marking",
  "Carton marking- Color sticker",
];

const TICKET_OUTPUTS = [
  output({ variantKey: "layout:a", displayName: "Coop DK - Private Label - Care Label", concept: "CARE_LABEL" }),
  output({ variantKey: "layout:b", displayName: "Coop 365 - Private Label - Banderole Info Area", concept: "BANDEROLE" }),
  output({ variantKey: "layout:c", displayName: "Coop DK - Private Label - Carton Marking", concept: "CARTON_MARKING", widthMm: 100, heightMm: 75 }),
];

test("the ticket style lists every Monday trim, plus what Monday omitted", () => {
  const docs = assembleTrimManifest({
    trimLabels: TICKET_TRIMS,
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });

  // Eight Monday entries in board order, then the banderole nobody asked for.
  assert.deepEqual(
    docs.map((d) => d.displayName),
    [...TICKET_TRIMS, "Coop 365 - Private Label - Banderole Info Area"],
  );

  const byName = new Map(docs.map((d) => [d.displayName, d]));
  // We generate these two.
  assert.equal(byName.get("Wash Care Label with Oeko-tex Logo")?.kind, "app");
  assert.equal(byName.get("Carton Marking")?.kind, "app");
  // Supplied outside the app.
  assert.equal(byName.get("Main label with size")?.kind, "manual");
  assert.equal(byName.get("Hangtag")?.kind, "manual");
  assert.equal(byName.get("Barcode sticker")?.kind, "manual");
  // Physical items — no artwork will ever arrive for these.
  assert.equal(byName.get("Black Hanger")?.kind, "info");
  assert.equal(byName.get("Master Polybag")?.kind, "info");
  // The 1,139-style trap: this is a colour sticker, NOT the carton marking,
  // so it must not be claimed by the carton-marking output.
  assert.equal(byName.get("Carton marking- Color sticker")?.kind, "manual");
});

test("a packing instruction carries no delivery state at all", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Black Hanger", "Hangtag"],
    outputs: [],
    rules: RULES,
    overrides: {},
  });
  const hanger = docs.find((d) => d.displayName === "Black Hanger");
  const hangtag = docs.find((d) => d.displayName === "Hangtag");
  // undefined, not false — an info row must never appear as "still to come".
  assert.equal(hanger?.approved, undefined);
  assert.equal(hangtag?.approved, false);
});

test("the Monday wording prints, with the document named beside it", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Wash Care Label with Oeko-tex Logo"],
    outputs: [TICKET_OUTPUTS[0]],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs[0].displayName, "Wash Care Label with Oeko-tex Logo");
  assert.deepEqual(docs[0].suppliedAs, ["Coop DK - Private Label - Care Label"]);
  // The size comes from the document that answers it.
  assert.equal(docs[0].widthMm, 25);
  assert.equal(docs[0].heightMm, 120);
});

test("a document already named like the trim doesn't repeat itself", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Carton Marking"],
    outputs: [output({ variantKey: "layout:c", displayName: "carton marking", concept: "CARTON_MARKING" })],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs[0].suppliedAs, undefined);
});

test("two documents answering one entry print no single size", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["carton Marking"],
    outputs: [
      output({ variantKey: "l1", displayName: "Front label", concept: "CARTON_MARKING", widthMm: 100, heightMm: 75 }),
      output({ variantKey: "l2", displayName: "Side label", concept: "CARTON_MARKING", widthMm: 60, heightMm: 40 }),
    ],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].widthMm, null);
  assert.equal(docs[0].heightMm, null);
  assert.deepEqual(docs[0].suppliedAs, ["Front label", "Side label"]);
});

test("an entry is approved only when every document answering it is", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["carton Marking"],
    outputs: [
      output({ variantKey: "l1", displayName: "Front label", concept: "CARTON_MARKING", approved: true }),
      output({ variantKey: "l2", displayName: "Side label", concept: "CARTON_MARKING", approved: false }),
    ],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs[0].approved, false);
});

test("a compound entry stays one row and takes its strongest kind", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Hanger & Hangtag"],
    outputs: [output({ variantKey: "l1", displayName: "Spar Kjøp - Loved - Hang Tag", concept: "HANGTAG" })],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].displayName, "Hanger & Hangtag");
  // HANGER is an info concept, HANGTAG is answered by a real output — the row
  // has to advertise the document.
  assert.equal(docs[0].kind, "app");
});

test("an override beats the rules, and an empty override hides the row", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["as PO00000", "carton marking- Barcode sticker (White)"],
    outputs: [],
    rules: RULES,
    overrides: {
      // Junk value: not packaging at all.
      "as po00000": [],
      // The rules read this as a carton marking; it is a barcode sticker.
      "carton marking barcode sticker white": ["BARCODE_STICKER"],
    },
  });
  assert.deepEqual(docs.map((d) => d.displayName), ["carton marking- Barcode sticker (White)"]);
  assert.equal(docs[0].kind, "manual");
});

test("unknown vocabulary is still printed, as manually supplied", () => {
  // The original bug was a short list. An entry we cannot classify must never
  // be the reason the supplier stops seeing it.
  const docs = assembleTrimManifest({
    trimLabels: ["Jack Bay Trim"],
    outputs: [],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, "manual");
  assert.equal(docs[0].approved, false);
});

test("a manual trim found in the order folder reads as delivered", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Main label with size"],
    outputs: [],
    rules: RULES,
    overrides: {},
    manualDelivered: new Set(["main label with size"]),
  });
  assert.equal(docs[0].approved, true);
});

test("an unclassifiable output is listed rather than lost", () => {
  const docs = assembleTrimManifest({
    trimLabels: ["Hangtag"],
    outputs: [output({ variantKey: "l1", displayName: "Spar Kjøp - Loved - Inner Pack Sticker", concept: null })],
    rules: RULES,
    overrides: {},
  });
  assert.deepEqual(docs.map((d) => d.displayName), ["Hangtag", "Spar Kjøp - Loved - Inner Pack Sticker"]);
});

test("an output is claimed once, never listed twice", () => {
  const docs = assembleTrimManifest({
    // Two entries naming the same concept.
    trimLabels: ["Wash Care Label", "Oekotex Label"],
    outputs: [TICKET_OUTPUTS[0]],
    rules: RULES,
    overrides: {},
  });
  // Both entries print (Monday listed both), and the care label is not
  // additionally appended as an unmatched output.
  assert.deepEqual(docs.map((d) => d.displayName), ["Wash Care Label", "Oekotex Label"]);
});

test("an empty Trims cell falls back to exactly today's manifest", () => {
  const docs = assembleTrimManifest({
    trimLabels: [],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.deepEqual(docs.map((d) => d.displayName), TICKET_OUTPUTS.map((o) => o.displayName));
  assert.equal(docs.every((d) => d.kind === "app"), true);
});

test("the fingerprint changes when the page reads differently, not otherwise", () => {
  const a = assembleTrimManifest({ trimLabels: TICKET_TRIMS, outputs: TICKET_OUTPUTS, rules: RULES, overrides: {} });
  const b = assembleTrimManifest({ trimLabels: TICKET_TRIMS, outputs: TICKET_OUTPUTS, rules: RULES, overrides: {} });
  assert.equal(manifestFingerprint(a), manifestFingerprint(b));

  // Same printed rows, different underlying key — not a reason to re-upload.
  const renamedKey = assembleTrimManifest({
    trimLabels: TICKET_TRIMS,
    outputs: TICKET_OUTPUTS.map((o) => ({ ...o, variantKey: `${o.variantKey}-v2` })),
    rules: RULES,
    overrides: {},
  });
  assert.equal(manifestFingerprint(renamedKey), manifestFingerprint(a));

  // An approval landing DOES change the page.
  const approved = assembleTrimManifest({
    trimLabels: TICKET_TRIMS,
    outputs: TICKET_OUTPUTS.map((o) => ({ ...o, approved: true })),
    rules: RULES,
    overrides: {},
  });
  assert.notEqual(manifestFingerprint(approved), manifestFingerprint(a));
});

test("the fingerprint cannot collide by running fields together", () => {
  const run = (displayName: string, sourceLabel: string) =>
    manifestFingerprint([
      { displayName, sourceLabel, widthMm: null, heightMm: null, fileCount: null, kind: "manual" },
    ]);
  assert.notEqual(run("AB", "C"), run("A", "BC"));
});

test("strongestKind ranks app over manual over info", () => {
  assert.equal(strongestKind(["info", "manual"]), "manual");
  assert.equal(strongestKind(["manual", "app"]), "app");
  assert.equal(strongestKind(["info"]), "info");
});

// ---- The master switch -----------------------------------------------------
//
// The switch itself is an AppSetting read, so the DB-backed half is exercised
// against the live app. What is pinned here is the property the switch relies
// on: with NO trim context, the assembler must reproduce the pre-Trims manifest
// exactly. If that ever drifted, "off" would silently start changing covers.

test("with no trim context the manifest is exactly the declared outputs", () => {
  const docs = assembleTrimManifest({
    trimLabels: [],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.deepEqual(
    docs.map((d) => ({
      displayName: d.displayName,
      widthMm: d.widthMm,
      heightMm: d.heightMm,
      approved: d.approved,
    })),
    TICKET_OUTPUTS.map((o) => ({
      displayName: o.displayName,
      widthMm: o.widthMm,
      heightMm: o.heightMm,
      approved: o.approved,
    })),
  );
  // No trim-only decoration leaks in: no Monday wording, no "supplied as", and
  // every row is still an ordinary generated document.
  assert.equal(docs.every((d) => d.sourceLabel === undefined), true);
  assert.equal(docs.every((d) => d.suppliedAs === undefined), true);
  assert.equal(docs.every((d) => d.kind === "app"), true);
});

test("switching on and off is a round trip, not a one-way door", () => {
  // The fingerprint of the off-state manifest must equal the fingerprint the
  // pre-Trims code produced, or flipping the switch off after a rebuild would
  // leave every cover looking permanently "changed".
  const off = assembleTrimManifest({
    trimLabels: [],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  const on = assembleTrimManifest({
    trimLabels: TICKET_TRIMS,
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.notEqual(manifestFingerprint(on), manifestFingerprint(off));
  const backOff = assembleTrimManifest({
    trimLabels: [],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.equal(manifestFingerprint(backOff), manifestFingerprint(off));
});

// ---- Per-concept copy ------------------------------------------------------
//
// A standing note about what a KIND of document is (see concept-copy.ts). It
// belongs to the concept, not to a customer's cover block, so it has to reach
// the row whichever side of the union that row came from — Monday's list or the
// declared outputs Monday never mentioned.

const CARE_NOTE = "Wash Care Label, these are created to be printed on one paper, front and back";

test("a concept's standing note rides the row, from either side of the union", () => {
  // From Monday's list: the entry classifies to CARE_LABEL and is answered by a
  // layout, so it is an "app" row.
  const fromMonday = assembleTrimManifest({
    trimLabels: ["Wash Care Label with Oeko-tex Logo"],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.equal(fromMonday[0].copy?.note, CARE_NOTE);

  // From the declared outputs alone — the care label nobody put on Monday.
  const fromOutputs = assembleTrimManifest({
    trimLabels: [],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  const care = fromOutputs.find((d) => d.displayName.endsWith("Care Label"));
  assert.equal(care?.copy?.note, CARE_NOTE);
});

test("a concept with nothing to say leaves the row without a copy field", () => {
  // Not `copy: {}` and not `copy: undefined` — the KEY must be absent, because
  // that is what keeps such a row's fingerprint identical to what it was before
  // concept copy existed.
  const docs = assembleTrimManifest({
    trimLabels: ["Carton Marking"],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  assert.equal(Object.prototype.hasOwnProperty.call(docs[0], "copy"), false);
});

test("a row that gained no note fingerprints exactly as it always did", () => {
  // The historical tuple, spelled out: whatever else changes, a row printing no
  // note must serialise to this — otherwise the day this shipped every cover in
  // the estate would read as changed and be rebuilt for nothing.
  const row = {
    displayName: "Carton Marking",
    widthMm: 100,
    heightMm: 75,
    fileCount: 1,
    approved: false,
    kind: "app" as const,
  };
  assert.equal(
    manifestFingerprint([row]),
    JSON.stringify([["Carton Marking", null, null, 100, 75, "app", false]]),
  );
});

test("a note changes the fingerprint, because it changes the page", () => {
  const withNote = assembleTrimManifest({
    trimLabels: ["Wash Care Label with Oeko-tex Logo"],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
  });
  const withoutNote = assembleTrimManifest({
    trimLabels: ["Wash Care Label with Oeko-tex Logo"],
    outputs: TICKET_OUTPUTS,
    rules: RULES,
    overrides: {},
    conceptCopy: {},
  });
  assert.notEqual(manifestFingerprint(withNote), manifestFingerprint(withoutNote));
});

// ---- Per-concept status wording --------------------------------------------

test("a banderole says what it is actually waiting for", () => {
  // "BANDEROLE, Fotoguide" is ONE item in a Monday cell, split on the comma
  // into two labels. Both halves classify to BANDEROLE, so both print the
  // banderole's own not-delivered wording — the alternative is two rows about
  // the same item saying different things.
  const docs = assembleTrimManifest({
    trimLabels: splitTrimsCell("BANDEROLE, Fotoguide"),
    outputs: [],
    rules: RULES,
    overrides: {},
  });
  assert.equal(docs.length, 2);
  for (const d of docs) {
    assert.equal(d.approved, false, "still to come");
    assert.equal(d.copy?.pending, "Awaiting Photo Samples from the supplier.");
  }
});

test("the wording is stored data, so a different setting produces different words", () => {
  // The proof that this is configuration rather than a branch: the SAME
  // assembler over the same style says something else when the copy says so.
  const docs = assembleTrimManifest({
    trimLabels: ["Banderole"],
    outputs: [],
    rules: RULES,
    overrides: {},
    conceptCopy: conceptCopyFromRows([
      { value: "BANDEROLE", label: "Banderole", artwork: true, pending: "Awaiting supplier samples" },
    ]),
  });
  assert.equal(docs[0].copy?.pending, "Awaiting supplier samples");
});

test("a packing instruction is given no status wording, whatever is configured", () => {
  // The hard rule, end to end: Master Polybag is on 1,733 styles and must stay
  // a note. A status would park all of them at "waiting" forever and bury the
  // rows that genuinely are waiting.
  const docs = assembleTrimManifest({
    trimLabels: ["Master Polybag", "Black Hanger"],
    outputs: [],
    rules: RULES,
    overrides: {},
    // Configured as aggressively as the store allows — the normaliser strips
    // the statuses, and the row-level guard would drop them even if it hadn't.
    conceptCopy: {
      POLYBAG: { note: "Clear, 40 micron.", pending: "Waiting", delivered: "Received" },
      HANGER: { pending: "Waiting", delivered: "Received" },
    },
  });
  for (const d of docs) {
    assert.equal(d.kind, "info", "still a packing instruction");
    assert.equal(d.approved, undefined, "and still has no delivery state");
    assert.equal(d.copy?.pending, undefined);
    assert.equal(d.copy?.delivered, undefined);
  }
  // The note is the one thing it may carry.
  assert.equal(docs[0].copy?.note, "Clear, 40 micron.");
});

// ---- The two per-row decisions ---------------------------------------------
//
// Both are read out of the synchronous concept registry, so each test installs
// a catalogue and puts the seed back afterwards — a leaked flag would change
// every later test in the file rather than fail this one.
//
// What is being pinned is the pair of meanings, because four booleans now hang
// off a row and the risk is that two of them quietly become the same thing:
//   alwaysManual — WHO supplies the file (not whether one exists: artwork)
//   printOnCover — whether it reaches PAPER (not whether the editor offers it:
//                  active, which is not visible from here at all — an inactive
//                  row still resolves and still prints, by design)

function withCatalogue<T>(overrides: Record<string, Partial<TrimConcept>>, fn: () => T): T {
  try {
    setTrimConceptCatalogue(
      DEFAULT_TRIM_CONCEPTS.map((c) => (overrides[c.value] ? { ...c, ...overrides[c.value] } : c)),
    );
    return fn();
  } finally {
    resetTrimConceptCatalogue();
  }
}

const HANGTAG_OUTPUT = output({
  variantKey: "layout:h",
  displayName: "Coop DK - Private Label - Hangtag",
  concept: "HANGTAG",
});

const hangtagDocs = () =>
  assembleTrimManifest({
    trimLabels: ["Hangtag", "Wash Care Label with Oeko-tex Logo"],
    outputs: [HANGTAG_OUTPUT],
    rules: RULES,
    overrides: {},
  });

test("without the flag, a matching output makes the line app-generated", () => {
  // The control for the two tests below: this is the behaviour "always
  // supplied by hand" exists to override, and it has to be the default.
  const byName = new Map(hangtagDocs().map((d) => [d.displayName, d]));
  assert.equal(byName.get("Hangtag")?.kind, "app");
  assert.equal(byName.size, 2, "the output was claimed by the Monday entry");
});

test("always-supplied-by-hand keeps the line manual against a matching output", () => {
  // The whole point: manual used to be only a FALLBACK, so the day somebody
  // added a hangtag layout this line stopped being an upload line and the
  // Review tab's drop zone for it disappeared. That the buyer draws it is a
  // property of the thing, not of which layouts happen to exist.
  withCatalogue({ HANGTAG: { alwaysManual: true } }, () => {
    const docs = hangtagDocs();
    const byName = new Map(docs.map((d) => [d.displayName, d]));
    assert.equal(byName.get("Hangtag")?.kind, "manual");
    assert.equal(byName.get("Hangtag")?.approved, false, "an upload is still owed");

    // And the document we DO produce is not swallowed: it is listed further
    // down under its own name, because the supplier receives it either way.
    // Concealing it would be the original bug wearing a new hat.
    assert.equal(byName.get("Coop DK - Private Label - Hangtag")?.kind, "app");
    assert.equal(
      docs.filter((d) => d.kind === "manual").map((d) => d.displayName).includes("Hangtag"),
      true,
      "so the Review tab builds a drop zone for it",
    );
  });
});

test("one always-by-hand concept is enough for a compound entry", () => {
  // "Hanger & Hangtag" is one row naming two things. If the buyer sends the
  // hangtag, the row still needs somewhere to receive it — a row cannot be half
  // an upload zone, so ANY always-manual concept decides it. Kind is otherwise
  // the STRONGEST of a row's concepts; this flag beats that ranking, which is
  // exactly what it is for.
  withCatalogue({ HANGTAG: { alwaysManual: true } }, () => {
    const docs = assembleTrimManifest({
      trimLabels: ["Hanger & Hangtag"],
      outputs: [HANGTAG_OUTPUT],
      rules: RULES,
      overrides: {},
    });
    assert.equal(docs[0].displayName, "Hanger & Hangtag");
    assert.equal(docs[0].kind, "manual");
  });
});

test("a hidden row prints nothing — not the Monday entry, not the document we generate", () => {
  // "Hidden" has to mean hidden, or it is not a lever anybody can trust. The
  // concept leaves the picture before assembly, so there is no line, no status,
  // and (because the Review tab builds its zones from the manifest's manual
  // lines) no drop zone.
  withCatalogue({ HANGTAG: { printOnCover: false } }, () => {
    const docs = assembleTrimManifest({
      trimLabels: ["Hangtag", "Wash Care Label with Oeko-tex Logo"],
      outputs: [HANGTAG_OUTPUT],
      rules: RULES,
      overrides: {},
    });
    assert.deepEqual(
      docs.map((d) => d.displayName),
      ["Wash Care Label with Oeko-tex Logo"],
    );
  });
});

test("hiding one concept of a compound entry leaves the entry printing", () => {
  // Unanimity to drop the row, the same way the STRONGEST concept decides its
  // kind. The entry is on the buyer's list because of the half still printing,
  // and the hidden half simply stops contributing — no match, no wording.
  withCatalogue({ HANGER: { printOnCover: false } }, () => {
    const docs = assembleTrimManifest({
      trimLabels: ["Hanger & Hangtag"],
      outputs: [],
      rules: RULES,
      overrides: {},
    });
    assert.equal(docs.length, 1);
    // Not "info": with HANGER gone the row names only the hangtag, which is a
    // document somebody still owes us.
    assert.equal(docs[0].kind, "manual");
  });
});

test("hiding a row cannot silence a Monday value nobody has mapped", () => {
  // The two levers are different sizes and must not be confused. Hiding a row
  // hides a KIND of packaging; a value that resolves to no row at all is not
  // that kind of anything, so it keeps printing — which is the failure this
  // whole feature exists to fix. To hide a WORD, map it to no rows at all
  // (isSuppressedLabel), which is what Settings › Trims offers.
  withCatalogue({ HANGTAG: { printOnCover: false } }, () => {
    const docs = assembleTrimManifest({
      trimLabels: ["Something nobody has mapped"],
      outputs: [],
      rules: RULES,
      overrides: {},
    });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].kind, "manual");
  });

  // And the other lever still reaches it, hidden row or not.
  const suppressed = assembleTrimManifest({
    trimLabels: ["Something nobody has mapped"],
    outputs: [],
    rules: RULES,
    overrides: { "something nobody has mapped": [] },
  });
  assert.deepEqual(suppressed, []);
});

test("neither flag set is byte-identical to the manifest before they existed", () => {
  // The day-one no-op. The columns default to "changes nothing", and the proof
  // is the fingerprint the refresh sweep compares: if it moved for one style,
  // the whole book would re-render and re-push to suppliers.
  const trims = [...TICKET_TRIMS, "Hanger & Hangtag", "Something nobody has mapped"];
  const build = () =>
    manifestFingerprint(
      assembleTrimManifest({ trimLabels: trims, outputs: TICKET_OUTPUTS, rules: RULES, overrides: {} }),
    );

  const before = build();

  // Through the normaliser, i.e. exactly what the table hands back once the
  // migration has added the two columns at their defaults.
  let after: string;
  try {
    setTrimConceptCatalogue(
      normalizeTrimConceptRows(DEFAULT_TRIM_CONCEPTS.map((c, i) => ({ ...c, sortOrder: i * 10 }))),
    );
    after = build();
  } finally {
    resetTrimConceptCatalogue();
  }
  assert.equal(after, before);

  // Not vacuous: ticking either flag DOES move it, which is why hiding a row
  // rebuilds the covers that carried the line.
  const hidden = withCatalogue({ HANGTAG: { printOnCover: false } }, build);
  assert.notEqual(hidden, before);

  // Always-by-hand only shows up where it has something to override, i.e.
  // against a style that DOES declare a hangtag layout — which is the whole
  // situation the flag was added for.
  const withLayout = () =>
    manifestFingerprint(
      assembleTrimManifest({
        trimLabels: trims,
        outputs: [...TICKET_OUTPUTS, HANGTAG_OUTPUT],
        rules: RULES,
        overrides: {},
      }),
    );
  assert.notEqual(withCatalogue({ HANGTAG: { alwaysManual: true } }, withLayout), withLayout());
});
