import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TRIM_CONCEPTS,
  DEFAULT_TRIM_CONCEPT_ROWS,
  normalizeTrimConceptRows,
  resetTrimConceptCatalogue,
  setTrimConceptCatalogue,
  trimConcept,
  trimConceptCatalogue,
  trimConceptLabel,
  conceptHasArtwork,
  trimConceptValueFromLabel,
  uniqueTrimConceptValue,
  type TrimConceptRow,
} from "./concepts";
import { conceptCopyFromRows } from "./concept-copy";
import { DEFAULT_TRIM_RULES, splitTrimsCell } from "./classify";
import { assembleTrimManifest, manifestFingerprint } from "./manifest";

// =====================================================
// THE DAY-ONE NO-OP.
//
// The packaging rows used to be a code constant and are now a table. The whole
// promise of that move is that nothing a supplier reads changes on the day it
// ships: the table is seeded from the constant, so every cover in the book has
// to fingerprint identically whichever side of the migration it is generated on.
//
// Proved rather than asserted by inspection, in three steps:
//   1. the migration's SEED is read off disk and compared to the constant,
//      value for value, label for label, flag for flag, wording for wording —
//      so a hand-edited migration cannot drift from the code it seeds;
//   2. a catalogue LOADED as rows produces the same copy map the constant did;
//   3. a manifest assembled over the whole live vocabulary fingerprints the
//      same with the constant installed as with the rows installed.
//
// This file is pure: no database. The DB glue in ./catalogue is three Prisma
// calls around normalizeTrimConceptRows, which is what is exercised here.
// =====================================================

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20260902120000_trim_concept_rows/migration.sql",
);

// Pull the seed INSERT out of the migration as { value, label, artwork, note,
// pending, delivered }. A deliberately small parser: the tuples are written one
// per line in a fixed column order, and anything it cannot read fails the test
// rather than being skipped, so a reformatted migration is caught rather than
// silently unverified.
function seedRowsFromMigration(): Array<Partial<TrimConceptRow>> {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf('INSERT INTO "trim_concept_rows"');
  assert.notEqual(start, -1, "the migration must still seed the catalogue");
  const end = sql.indexOf('ON CONFLICT ("value") DO NOTHING;', start);
  assert.notEqual(end, -1, "the seed must stay idempotent");
  const body = sql.slice(sql.indexOf("VALUES", start) + "VALUES".length, end);

  const rows: Array<Partial<TrimConceptRow>> = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("(")) continue;
    const inner = trimmed.slice(1, trimmed.lastIndexOf(")"));
    // Split on commas that are not inside a quoted literal. Labels contain
    // slashes and notes contain commas, so a naive split would mangle both.
    const parts: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === "'") {
        // '' inside a literal is an escaped quote, not the end of one.
        if (quoted && inner[i + 1] === "'") {
          current += "''";
          i += 1;
          continue;
        }
        quoted = !quoted;
        current += ch;
        continue;
      }
      if (ch === "," && !quoted) {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current.trim());

    const text = (raw: string): string | undefined => {
      if (raw === "NULL") return undefined;
      assert.ok(raw.startsWith("'") && raw.endsWith("'"), `unparsed literal: ${raw}`);
      return raw.slice(1, -1).replace(/''/g, "'");
    };
    rows.push({
      value: text(parts[0]),
      label: text(parts[1]),
      artwork: parts[2] === "true",
      note: text(parts[3]),
      pending: text(parts[4]),
      delivered: text(parts[5]),
      sortOrder: Number(parts[6]),
    });
  }
  return rows;
}

test("the migration seeds exactly the catalogue the code falls back to", () => {
  // The single most load-bearing assertion in this file. An install that has run
  // the migration and one that has not must classify and print identically, and
  // the only way that holds is if the seed IS the constant.
  const seeded = seedRowsFromMigration();
  assert.equal(
    seeded.length,
    DEFAULT_TRIM_CONCEPTS.length,
    "a row added to the code catalogue needs a matching seed row (and vice versa)",
  );
  seeded.forEach((row, i) => {
    const expected = DEFAULT_TRIM_CONCEPT_ROWS[i];
    assert.equal(row.value, expected.value, `row ${i}: value`);
    assert.equal(row.label, expected.label, `${expected.value}: label`);
    assert.equal(row.artwork, expected.artwork, `${expected.value}: artwork`);
    assert.equal(row.note, expected.note, `${expected.value}: note`);
    assert.equal(row.pending, expected.pending, `${expected.value}: pending`);
    assert.equal(row.delivered, expected.delivered, `${expected.value}: delivered`);
    assert.equal(row.sortOrder, expected.sortOrder, `${expected.value}: sortOrder`);
  });
});

test("the seed rows survive a round trip through the store unchanged", () => {
  // What the table hands back, normalised, has to be what went in — otherwise
  // the first save of an untouched catalogue would edit it.
  assert.deepEqual(normalizeTrimConceptRows(DEFAULT_TRIM_CONCEPT_ROWS), DEFAULT_TRIM_CONCEPT_ROWS);
});

test("a catalogue loaded from rows produces the copy map the constant did", () => {
  // The wording used to live in its own blob keyed by concept. Moving it onto
  // the row must produce the identical map, sparse entries and all — a map with
  // empty husks in it would shift every manifest fingerprint in the book.
  assert.deepEqual(conceptCopyFromRows(DEFAULT_TRIM_CONCEPT_ROWS), {
    CARE_LABEL: {
      note: "Wash Care Label, these are created to be printed on one paper, front and back",
    },
    BANDEROLE: { pending: "Awaiting Photo Samples from the supplier." },
  });
});

// The vocabulary a cover actually meets, in the shapes that make it awkward:
// compound entries, a packing instruction, an unmapped one-off, and the two
// concepts that carry seeded wording.
const LIVE_VOCABULARY = [
  "Wash Care Label with Oeko-tex Logo",
  "Carton marking- Color sticker",
  "Hanger & Hangtag",
  "Hangtag + Banderole",
  "Polybag + Inlaycard + Hangtag",
  "Master Polybag",
  "BANDEROLE, Fotoguide",
  "Main label",
  "Something nobody has mapped",
];

function manifestOverVocabulary(): string {
  return manifestFingerprint(
    assembleTrimManifest({
      trimLabels: LIVE_VOCABULARY.flatMap((cell) => splitTrimsCell(cell)),
      outputs: [],
      rules: DEFAULT_TRIM_RULES,
      overrides: {},
      conceptCopy: conceptCopyFromRows(trimConceptCatalogue()),
    }),
  );
}

test("day one is a no-op: the same covers print whether the catalogue is code or a table", () => {
  try {
    // BEFORE — the seed constant, i.e. an install where the migration has not
    // run, or the table is unreachable and the loader fell back.
    resetTrimConceptCatalogue();
    const fromCode = manifestOverVocabulary();

    // AFTER — the catalogue installed from rows in the shape the table returns,
    // through the same normaliser the loader uses.
    setTrimConceptCatalogue(
      normalizeTrimConceptRows(
        DEFAULT_TRIM_CONCEPT_ROWS.map((r) => ({ ...r, sortOrder: r.sortOrder })),
      ),
    );
    const fromTable = manifestOverVocabulary();

    assert.equal(fromTable, fromCode, "a cover must not change on the day the table ships");
    // And the fingerprint is not vacuously equal: it carries the seeded wording,
    // the packing-instruction rows and the unmapped one-off.
    assert.match(fromCode, /Awaiting Photo Samples from the supplier\./);
    assert.match(fromCode, /Wash Care Label/);
    assert.match(fromCode, /Something nobody has mapped/);
  } finally {
    resetTrimConceptCatalogue();
  }
});

test("an unmapped value still prints, as something supplied separately", () => {
  // The failure this whole feature exists to fix: a value nobody has matched to
  // a row is on the buyer's list, so the supplier must see it. "Expect this,
  // source unconfirmed" is the honest under-claim; hiding it is the old bug.
  const docs = assembleTrimManifest({
    trimLabels: ["Something nobody has mapped"],
    outputs: [],
    rules: DEFAULT_TRIM_RULES,
    overrides: {},
  });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].displayName, "Something nobody has mapped");
  assert.equal(docs[0].kind, "manual");
  assert.equal(docs[0].approved, false, "it reads as still to come, not as delivered");
});

// ---- The registry ----------------------------------------------------------

test("an empty load leaves the seed in place rather than emptying the vocabulary", () => {
  // An empty table is far more likely to be a migration that has not run than a
  // person who deleted every row — the editor deactivates, it does not delete —
  // and honouring it would turn every concept in the book unknown at once.
  try {
    setTrimConceptCatalogue([]);
    assert.equal(trimConceptCatalogue().length, DEFAULT_TRIM_CONCEPTS.length);
    assert.equal(conceptHasArtwork("POLYBAG"), false);
  } finally {
    resetTrimConceptCatalogue();
  }
});

test("a row added to the table is visible to the synchronous readers", () => {
  try {
    setTrimConceptCatalogue([
      ...DEFAULT_TRIM_CONCEPTS,
      { value: "SILICA_SACHET", label: "Silica sachet", artwork: false },
    ]);
    assert.equal(trimConceptLabel("SILICA_SACHET"), "Silica sachet");
    assert.equal(conceptHasArtwork("SILICA_SACHET"), false);
    assert.equal(trimConcept("SILICA_SACHET")?.artwork, false);
  } finally {
    resetTrimConceptCatalogue();
  }
});

test("a value naming a row nobody has any more degrades safely", () => {
  // A removed row is still LOADED, so this is the case where a mapping outlives
  // the catalogue entirely (a hand-edited table, an older mapping). It reads as
  // a title-cased name and as artwork — never as a packing note, because
  // mislabelling a document as a note drops it from the manifest.
  assert.equal(trimConceptLabel("SOME_RETIRED_ROW"), "Some Retired Row");
  assert.equal(conceptHasArtwork("SOME_RETIRED_ROW"), true);
});

// ---- Minting a value for a new row -----------------------------------------

test("a new row's id is derived from its label, once", () => {
  assert.equal(trimConceptValueFromLabel("Inlay card / insert"), "INLAY_CARD_INSERT");
  assert.equal(trimConceptValueFromLabel("  Silica sachet  "), "SILICA_SACHET");
  // A leading digit is prefixed: the value is also a JSON object key in the
  // stored mappings, and "12_PACK" reading as a number somewhere downstream is
  // a trap not worth leaving.
  assert.equal(trimConceptValueFromLabel("12 pack"), "ROW_12_PACK");
  assert.equal(trimConceptValueFromLabel("///"), "");
});

test("two rows that derive the same id are kept apart", () => {
  // "Top card" and "Top-card" derive the same value. Merging them would remap
  // every trim on one of them to the other, silently.
  const taken = new Set(DEFAULT_TRIM_CONCEPTS.map((c) => c.value));
  assert.equal(uniqueTrimConceptValue("Silica sachet", taken), "SILICA_SACHET");
  taken.add("SILICA_SACHET");
  assert.equal(uniqueTrimConceptValue("Silica-sachet", taken), "SILICA_SACHET_2");
  // And it never collides with a built-in either.
  assert.equal(uniqueTrimConceptValue("Care label", taken), "CARE_LABEL_2");
});
