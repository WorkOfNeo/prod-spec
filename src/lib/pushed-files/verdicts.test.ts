import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPushedFileCheck,
  groupPushedHistograms,
  summarisePushedRows,
  type PushedFolderFile,
  type PushedRecord,
} from "./verdicts";

// Every name here is invented. The repo is public; no live PO, style, supplier
// or file name goes into a fixture.

let seq = 0;
function file(fileName: string, itemId?: string): PushedFolderFile {
  seq += 1;
  return { fileName, itemId: itemId ?? `item-${seq}`, webUrl: null, size: 2048, lastModifiedAt: null };
}

function record(over: Partial<PushedRecord> & { pushedName: string }): PushedRecord {
  seq += 1;
  return {
    queueItemId: `q-${seq}`,
    styleId: "style-ab10001",
    styleName: "AB10001",
    docType: "Care label",
    displayName: null,
    poNumber: "PO-TEST-1",
    poSeq: 70000,
    currentName: over.pushedName,
    currentNote: null,
    ...over,
  };
}

// --- The structural guarantee --------------------------------------------

test("a file no record claims produces no row at all — not flagged, not reported", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "ours.pdf" })],
    present: [file("ours.pdf"), file("suppliers-own-packing-list.pdf"), file("buyer-contract.pdf")],
    minPo: null,
  });
  assert.equal(s.records, 1);
  assert.equal(s.flagged.length + s.reported.length, 1, "one record in, one row out");
  const all = [...s.flagged, ...s.reported].map((r) => r.fileName);
  assert.deepEqual(all, ["ours.pdf"]);
});

test("no records means no rows, however full the folder is", () => {
  const s = buildPushedFileCheck({
    records: [],
    present: [file("a.pdf"), file("b.pdf"), file("c.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.reported.length, 0);
});

// --- Correct ---------------------------------------------------------------

test("present under today's name is coverage, never a fault", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care-ab10001.pdf", currentName: "care-ab10001.pdf" })],
    present: [file("care-ab10001.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.reported[0].kind, "matches");
  assert.deepEqual(s.reported[0].allowed, []);
});

test("case and sanitisation differences are the same name", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "Care-AB10001.pdf", currentName: "care-ab10001.PDF" })],
    present: [file("CARE-ab10001.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.reported[0].kind, "matches");
});

test("a file somebody already renamed to today's name is healthy, not gone", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "old-care.pdf", currentName: "new-care.pdf" })],
    present: [file("new-care.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.reported[0].kind, "matches");
});

// --- Name drift ------------------------------------------------------------

test("drifted name with no replacement present is a rename, and only a rename", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "old-care.pdf", currentName: "new-care.pdf" })],
    present: [file("old-care.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 1);
  const r = s.flagged[0];
  assert.equal(r.kind, "name-drifted");
  assert.equal(r.proposed, "rename");
  assert.deepEqual(r.allowed, ["rename"], "deleting the supplier's only copy is never the repair");
  assert.equal(r.renameTo, "new-care.pdf");
});

test("drift is judged against TODAY's name, not the name we pushed", () => {
  // The stored/pushed name agreeing with the file is NOT enough: the whole
  // point is that the template moved on afterwards.
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "june-name.pdf", currentName: "september-name.pdf" })],
    present: [file("june-name.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged[0].kind, "name-drifted");
  assert.equal(s.flagged[0].renameTo, "september-name.pdf");
});

// --- Superseded duplicates -------------------------------------------------

test("an old copy next to its replacement is a delete, pre-selected", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "old-care.pdf", currentName: "new-care.pdf" })],
    present: [file("old-care.pdf"), file("new-care.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 1);
  const r = s.flagged[0];
  assert.equal(r.kind, "superseded-duplicate");
  assert.equal(r.proposed, "delete");
  assert.deepEqual(r.allowed, ["delete"]);
  assert.equal(r.renameTo, null, "there is nothing to rename onto — the name is taken");
  assert.equal(r.fileName, "old-care.pdf", "the OLD copy is the one flagged");
});

// --- Cutoff ----------------------------------------------------------------

test("a file pushed below the cutoff is flagged, and never pre-selected", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", poSeq: 62000 })],
    present: [file("care.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged.length, 1);
  const r = s.flagged[0];
  assert.equal(r.kind, "below-cutoff");
  assert.equal(r.proposed, null, "removing a file a supplier may be printing from is a person's call");
  assert.deepEqual(r.allowed, ["delete"]);
});

test("the cutoff outranks a name question — a file that should not be here is not renamed into place", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "old.pdf", currentName: "new.pdf", poSeq: 62000 })],
    present: [file("old.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged[0].kind, "below-cutoff");
  assert.equal(s.flagged[0].renameTo, null);
});

test("at the cutoff is IN scope — the rule is poSeq < minPo", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", poSeq: 63320 })],
    present: [file("care.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged.length, 0);
});

test("an unset cutoff puts nothing below it", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", poSeq: 1 })],
    present: [file("care.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
});

test("a record with no poSeq is never called below the cutoff", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", poSeq: null })],
    present: [file("care.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged.length, 0);
});

// --- Gone ------------------------------------------------------------------

test("a file we pushed that is not there is reported, and carries no action", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", currentName: "care.pdf" })],
    present: [file("something-else.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
  const r = s.reported[0];
  assert.equal(r.kind, "gone");
  assert.equal(r.itemId, null);
  assert.deepEqual(r.allowed, []);
  assert.equal(r.proposed, null);
  assert.equal(s.notes.length, 1);
});

// --- Collisions ------------------------------------------------------------

test("two records pointing at one file are reported and nothing is offered", () => {
  const shared = file("split-layout.pdf", "item-shared");
  const s = buildPushedFileCheck({
    records: [
      record({ pushedName: "split-layout.pdf", currentName: "split-layout.pdf" }),
      record({ pushedName: "split-layout.pdf", currentName: "split-layout.pdf" }),
    ],
    present: [shared],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0, "neither copy is safe to touch");
  assert.equal(s.reported.length, 2);
  for (const r of s.reported) assert.equal(r.kind, "collision");
  for (const r of s.reported) assert.deepEqual(r.allowed, []);
});

test("a collision outranks the cutoff — still nothing offered", () => {
  const shared = file("split-layout.pdf", "item-shared");
  const s = buildPushedFileCheck({
    records: [
      record({ pushedName: "split-layout.pdf", poSeq: 60000 }),
      record({ pushedName: "split-layout.pdf", poSeq: 60000 }),
    ],
    present: [shared],
    minPo: 63320,
  });
  assert.equal(s.flagged.length, 0);
  for (const r of s.reported) assert.deepEqual(r.allowed, []);
});

// --- Unverifiable ----------------------------------------------------------

test("no current name means no judgement and no action", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", currentName: null, currentNote: "layout unpublished" })],
    present: [file("care.pdf")],
    minPo: null,
  });
  assert.equal(s.flagged.length, 0);
  const r = s.reported[0];
  assert.equal(r.kind, "unverifiable");
  assert.deepEqual(r.allowed, []);
  assert.equal(r.detail, "layout unpublished");
});

test("the cutoff still applies when the current name is unresolvable", () => {
  const s = buildPushedFileCheck({
    records: [record({ pushedName: "care.pdf", currentName: null, poSeq: 100 })],
    present: [file("care.pdf")],
    minPo: 63320,
  });
  assert.equal(s.flagged[0].kind, "below-cutoff");
});

// --- Rollup ----------------------------------------------------------------

test("the rollup counts files and the folders they came from", () => {
  const a = summarisePushedRows(
    buildPushedFileCheck({
      records: [record({ pushedName: "a.pdf", currentName: "b.pdf" })],
      present: [file("a.pdf")],
      minPo: null,
    }).flagged,
  );
  const b = summarisePushedRows(
    buildPushedFileCheck({
      records: [
        record({ pushedName: "c.pdf", currentName: "d.pdf" }),
        record({ pushedName: "e.pdf", currentName: "f.pdf" }),
      ],
      present: [file("c.pdf"), file("e.pdf")],
      minPo: null,
    }).flagged,
  );
  const groups = groupPushedHistograms([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "name-drifted");
  assert.equal(groups[0].files, 3);
  assert.equal(groups[0].folders, 2);
  assert.equal(groups[0].renameable, 3);
  assert.equal(groups[0].deletable, 0);
});

test("faults sort ahead of coverage", () => {
  const s = buildPushedFileCheck({
    records: [
      record({ pushedName: "ok.pdf", currentName: "ok.pdf" }),
      record({ pushedName: "stale.pdf", currentName: "fresh.pdf" }),
    ],
    present: [file("ok.pdf"), file("stale.pdf")],
    minPo: null,
  });
  const groups = groupPushedHistograms([summarisePushedRows([...s.flagged, ...s.reported])]);
  assert.equal(groups[0].kind, "name-drifted");
  assert.equal(groups[0].flagged, true);
  assert.equal(groups[groups.length - 1].kind, "matches");
});
