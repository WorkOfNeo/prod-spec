import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverCheck,
  buildFileNameCheck,
  type FolderFile,
  type ExpectedCover,
  type ExpectedDoc,
} from "./po-checks";

// Every name here is invented. The repo is public; no live PO, style or
// supplier goes into a fixture.

let seq = 0;
function file(fileName: string, location: FolderFile["location"] = "approved-layouts"): FolderFile {
  seq += 1;
  return { fileName, itemId: `item-${seq}`, webUrl: null, size: 1024, lastModifiedAt: null, location };
}

function cover(styleName: string, currentName: string, previousName: string | null = null): ExpectedCover {
  return { styleId: `style-${styleName}`, styleName, styleSlug: styleName.toLowerCase(), currentName, previousName };
}

function doc(name: string, fileName: string, previousFileName: string | null = null): ExpectedDoc {
  return { fileName, previousFileName, styleId: "style-ab10001", styleName: "AB10001", name, nameNote: null };
}

const row = (s: { flagged: Array<{ fileName: string }> }, fileName: string) =>
  s.flagged.find((r) => r.fileName === fileName)!;

// --- Check 1: cover pages -------------------------------------------------

test("a cover the PO expects is coverage, not a finding", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-cover-page.pdf")],
    present: [file("00-ab10001-cover-page.pdf")],
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.ok.length, 1, "it still has to be SHOWN — coverage is the second group");
  assert.equal(s.scanned, 1);
});

test("every style on the PO is expected, because the folder is the PO's", () => {
  // The whole reason the check resolves the full style list: judged against one
  // style, the other's perfectly good cover would read as a stray to delete.
  const s = buildCoverCheck({
    expected: [
      cover("AB10001", "00-ab10001-blue-cover-page.pdf"),
      cover("AB10002", "00-ab10002-cover-page.pdf"),
    ],
    present: [file("00-ab10001-blue-cover-page.pdf"), file("00-ab10002-cover-page.pdf")],
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.ok.length, 2);
});

test("a cover under an old name is renamed, never deleted — it is the only copy", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-blue-cover-page.pdf", "00-ab10001-cover-page.pdf")],
    present: [file("00-ab10001-cover-page.pdf")],
  });
  const r = row(s, "00-ab10001-cover-page.pdf");
  assert.equal(r.proposed, "rename");
  assert.equal(r.renameTo, "00-ab10001-blue-cover-page.pdf");
});

test("an old cover whose replacement is already there is a leftover, and delete is proposed", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-blue-cover-page.pdf", "00-ab10001-cover-page.pdf")],
    present: [file("00-ab10001-cover-page.pdf"), file("00-ab10001-blue-cover-page.pdf")],
  });
  assert.equal(s.flagged.length, 1);
  assert.equal(row(s, "00-ab10001-cover-page.pdf").proposed, "delete");
  assert.equal(s.ok.length, 1, "the current one is coverage");
});

test("a cover for a style that is NOT on this PO is the finding this check exists for", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-cover-page.pdf")],
    present: [file("00-ab10001-cover-page.pdf"), file("00-zz90099-cover-page.pdf")],
  });
  const r = row(s, "00-zz90099-cover-page.pdf");
  assert.equal(r.proposed, "delete");
  assert.deepEqual(r.allowed, ["delete"]);
  assert.ok(/zz90099/.test(r.verdict));
});

test("a cover we cannot explain is listed with NOTHING pre-selected", () => {
  // Two shapes, one rule: the app does not recommend a deletion it cannot
  // justify in a sentence. Both are still actionable by a human.
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-cover-page.pdf")],
    present: [file("00-ab10001-old-final-cover-page.pdf"), file("Cover Page.pdf")],
  });
  const attributed = row(s, "00-ab10001-old-final-cover-page.pdf");
  assert.equal(attributed.proposed, null);
  assert.deepEqual(attributed.allowed, ["delete"]);
  assert.equal(attributed.owner?.styleName, "AB10001", "it still says whose it looks like");

  const foreign = row(s, "Cover Page.pdf");
  assert.equal(foreign.proposed, null);
  assert.deepEqual(foreign.allowed, ["delete"]);
});

test("nothing outside APPROVED LAYOUTS is ever offered an action", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-cover-page.pdf")],
    present: [file("00-zz90099-cover-page.pdf", "po-folder")],
  });
  const r = row(s, "00-zz90099-cover-page.pdf");
  assert.equal(r.proposed, null, "it would be a delete inside APPROVED LAYOUTS — here it is report-only");
  assert.deepEqual(r.allowed, []);
});

test("a style with no cover in the folder is a note, not a file row", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-ab10001-cover-page.pdf"), cover("AB10002", "00-ab10002-cover-page.pdf")],
    present: [file("00-ab10001-cover-page.pdf")],
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.notes.length, 1);
  assert.ok(/AB10002/.test(s.notes[0]));
});

test("matching is case-insensitive and uses the sanitised name the push writes", () => {
  const s = buildCoverCheck({
    expected: [cover("AB10001", "00-AB10001-Cover-Page.pdf")],
    present: [file("00-ab10001-cover-page.pdf")],
  });
  assert.equal(s.flagged.length, 0);
});

// --- Check 2: misnamed output files ---------------------------------------

test("a file matching today's template is coverage", () => {
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label.pdf")],
    present: [file("ab10001-care-label.pdf")],
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.ok.length, 1);
});

test("a drifted name is compared against TODAY's template, and renamed", () => {
  // The stamp says the old name; the template resolves to the new one. That
  // gap is the entire check — comparing against the stamp would find nothing.
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label-s.pdf", "ab10001-care-label.pdf")],
    present: [file("ab10001-care-label.pdf")],
  });
  const r = row(s, "ab10001-care-label.pdf");
  assert.equal(r.proposed, "rename");
  assert.equal(r.renameTo, "ab10001-care-label-s.pdf");
  assert.deepEqual(r.allowed, ["rename", "delete"], "both actions, rename first");
});

test("a stale duplicate is deleted, not renamed onto the file already there", () => {
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label-s.pdf", "ab10001-care-label.pdf")],
    present: [file("ab10001-care-label.pdf"), file("ab10001-care-label-s.pdf")],
  });
  assert.equal(row(s, "ab10001-care-label.pdf").proposed, "delete");
  assert.equal(s.ok.length, 1);
});

test("a leaked layout id is flagged even when it is exactly what the config asks for", () => {
  // The steady state of the defect: the template is STILL empty, so the leaked
  // name is what resolves today and a naive expected-set match calls it fine.
  const leaked = "ab10001-layout-clw9k2h4x0000abcd1234efgh-s.pdf";
  const s = buildFileNameCheck({ expected: [doc("Care label", leaked)], present: [file(leaked)] });
  assert.equal(s.ok.length, 0, "it must NOT read as coverage");
  const r = row(s, leaked);
  assert.equal(r.proposed, null);
  assert.deepEqual(r.allowed, [], "there is no correct name to rename to yet, and deleting loses the artwork");
  assert.ok(/file name is empty/i.test(r.detail ?? ""));
});

test("a leaked layout id the template has since replaced is a straight rename", () => {
  const leaked = "ab10001-layout-clw9k2h4x0000abcd1234efgh-s.pdf";
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label-s.pdf", leaked)],
    present: [file(leaked)],
  });
  const r = row(s, leaked);
  assert.equal(r.proposed, "rename");
  assert.equal(r.renameTo, "ab10001-care-label-s.pdf");
});

test("a leaked layout id nothing claims is listed, with delete merely permitted", () => {
  const leaked = "zz90099-layout-clw9k2h4x0000abcd1234efgh-m.pdf";
  const s = buildFileNameCheck({ expected: [doc("Care label", "ab10001-care-label.pdf")], present: [file(leaked)] });
  const r = row(s, leaked);
  assert.equal(r.proposed, null);
  assert.deepEqual(r.allowed, ["delete"]);
});

test("a file nobody claims is left alone, not flagged", () => {
  // Suppliers and customers put their own files in this folder. "Not ours" is
  // coverage, not a finding — flagging it would train reviewers to tick past it.
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label.pdf")],
    present: [file("supplier-packing-note.pdf")],
  });
  assert.equal(s.flagged.length, 0);
  assert.equal(s.ok.length, 1);
});

test("covers are check 1's subject and never appear in check 2", () => {
  const s = buildFileNameCheck({
    expected: [doc("Care label", "ab10001-care-label.pdf")],
    present: [file("00-ab10001-cover-page.pdf"), file("ab10001-care-label.pdf")],
  });
  assert.equal(s.scanned, 1);
  assert.equal(s.flagged.length + s.ok.length, 1);
});
