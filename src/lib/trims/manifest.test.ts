import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRIM_RULES } from "./classify";
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
