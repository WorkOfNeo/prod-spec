import { test } from "node:test";
import assert from "node:assert/strict";
import { styleSubfolderApplies, styleSubfolderName } from "./supplier-folder-names";
import { planStyleFolderMove, type MovePlanInput } from "./move-to-style-subfolder";
import type { ApprovedLayoutsFile } from "./supplier-folder";

// =====================================================
// The per-style subfolder inside APPROVED LAYOUTS: its name, the cutoff that
// decides who gets one, and the plan the "move into style folder" action makes.
// All pure — no Graph, no database.
// =====================================================

test("subfolder is '<style> - <colour>', colour name first", () => {
  assert.equal(styleSubfolderName({ styleNumber: "AB10001", colour: { name: "Navy", code: "*Blue" } }), "AB10001 - Navy");
});

test("falls back to the colour code, with Monday's '*' marker stripped", () => {
  assert.equal(styleSubfolderName({ styleNumber: "AB10001", colour: { name: "", code: "*Blue" } }), "AB10001 - Blue");
});

test("no colour → the style number alone, never a dangling ' - '", () => {
  assert.equal(styleSubfolderName({ styleNumber: "AB10001", colour: null }), "AB10001");
  assert.equal(styleSubfolderName({ styleNumber: "AB10001", colour: { name: " ", code: "*" } }), "AB10001");
  assert.equal(styleSubfolderName({ styleNumber: "AB10001", colour: { name: "-" } }), "AB10001");
});

test("characters SharePoint forbids in a folder name are removed", () => {
  assert.equal(styleSubfolderName({ styleNumber: "AB/100", colour: { name: 'Navy "Blue"' } }), "AB 100 - Navy Blue");
});

test("cutoff: unset means the flat layout for everyone", () => {
  assert.equal(styleSubfolderApplies(70000, null), false);
});

test("cutoff: at or above gets a subfolder, below stays flat", () => {
  assert.equal(styleSubfolderApplies(63500, 63500), true);
  assert.equal(styleSubfolderApplies(63501, 63500), true);
  assert.equal(styleSubfolderApplies(63499, 63500), false);
});

test("cutoff: a PO that can't be placed on the timeline stays flat", () => {
  assert.equal(styleSubfolderApplies(null, 63500), false);
  assert.equal(styleSubfolderApplies(undefined, 63500), false);
});

// ---- planStyleFolderMove

let seq = 0;
function file(name: string, subfolder: string | null = null, id?: string): ApprovedLayoutsFile {
  seq += 1;
  return {
    id: id ?? `item-${seq}`,
    name,
    webUrl: null,
    size: 100,
    lastModifiedAt: null,
    subfolder: subfolder ? { id: `folder-${subfolder}`, name: subfolder, webUrl: null } : null,
  };
}

function input(over: Partial<MovePlanInput>): MovePlanInput {
  return {
    files: [],
    targetSubfolder: "AB10001 - Navy",
    previousSubfolder: null,
    ownNames: new Map(),
    siblingNames: new Map(),
    manualItemIds: new Set(),
    ...over,
  };
}

const own = (...names: string[]) =>
  new Map(names.map((n, i) => [n.toLowerCase(), { jobAssetId: `asset-${i}`, pushable: true }]));

test("this style's flat files move; other styles' files aren't touched or listed", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("ab10001-navy-care-label.pdf"), file("ab20002-care-label.pdf"), file("someone-elses.pdf")],
      ownNames: own("ab10001-navy-care-label.pdf"),
      siblingNames: new Map([["ab20002-care-label.pdf", ["AB20002"]]]),
    }),
  );
  assert.deepEqual(
    plan.map((p) => [p.fileName, p.action]),
    [["ab10001-navy-care-label.pdf", "move"]],
  );
  assert.equal(plan[0].from, "APPROVED LAYOUTS");
  assert.equal(plan[0].jobAssetId, "asset-0", "carries the asset so the queue row's link can be updated");
});

test("names are matched the way SharePoint stores them (sanitised, case-insensitive)", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("AB10001-layout-xyz.PDF")],
      ownNames: own("ab10001-layout-xyz.pdf"),
    }),
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "move");
});

test("a name another style on the PO also uses is copied from our own bytes, never moved", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("00-ab10001-cover-page.pdf")],
      ownNames: own("00-ab10001-cover-page.pdf"),
      siblingNames: new Map([["00-ab10001-cover-page.pdf", ["AB10001 (Black)"]]]),
    }),
  );
  assert.equal(plan[0].action, "copy");
  assert.equal(plan[0].jobAssetId, "asset-0");
  assert.deepEqual(plan[0].sharedWith, ["AB10001 (Black)"]);
});

test("a shared name with no approved bytes to copy is left, with a reason", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("ab10001-hangtag.pdf")],
      ownNames: new Map([["ab10001-hangtag.pdf", { jobAssetId: "a1", pushable: false }]]),
      siblingNames: new Map([["ab10001-hangtag.pdf", ["AB10001 (Black)"]]]),
    }),
  );
  assert.equal(plan[0].action, "left");
  assert.ok(plan[0].reason);
});

test("a flat copy of a file already in the style's folder is a duplicate to remove", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("ab10001-navy-care-label.pdf"), file("ab10001-navy-care-label.pdf", "AB10001 - Navy")],
      ownNames: own("ab10001-navy-care-label.pdf"),
    }),
  );
  assert.deepEqual(
    plan.map((p) => [p.from, p.action]),
    [["APPROVED LAYOUTS", "remove-duplicate"]],
    "the copy already in the folder is left alone and not listed",
  );
});

test("a shared flat name whose own copy is already home is left for the sibling, not deleted", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("00-ab10001-cover-page.pdf"), file("00-ab10001-cover-page.pdf", "AB10001 - Navy")],
      ownNames: own("00-ab10001-cover-page.pdf"),
      siblingNames: new Map([["00-ab10001-cover-page.pdf", ["AB10001 (Black)"]]]),
    }),
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "left");
});

test("manually supplied documents are recognised by item id, whatever their name", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("ab10001-navy-banderole-12345.pdf", null, "manual-1")],
      manualItemIds: new Set(["manual-1"]),
    }),
  );
  assert.equal(plan[0].action, "move");
  assert.equal(plan[0].jobAssetId, null);
});

test("re-homing after a colour fix: everything in the old subfolder moves, other subfolders stay", () => {
  const plan = planStyleFolderMove(
    input({
      targetSubfolder: "AB10001 - Navy",
      previousSubfolder: "AB10001 - Blue",
      files: [
        file("ab10001-care-label.pdf", "AB10001 - Blue"),
        file("anything-a-person-put-here.pdf", "AB10001 - Blue"),
        file("ab10001-care-label.pdf", "AB10001 - Black"),
      ],
    }),
  );
  assert.deepEqual(
    plan.map((p) => [p.fileName, p.from, p.action]),
    [
      ["ab10001-care-label.pdf", "APPROVED LAYOUTS/AB10001 - Blue", "move"],
      ["anything-a-person-put-here.pdf", "APPROVED LAYOUTS/AB10001 - Blue", "move"],
    ],
  );
});

test("files already in the style's folder produce no plan at all", () => {
  const plan = planStyleFolderMove(
    input({
      files: [file("ab10001-navy-care-label.pdf", "ab10001 - navy")],
      ownNames: own("ab10001-navy-care-label.pdf"),
    }),
  );
  assert.deepEqual(plan, []);
});
