import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFindings, groupHistograms, summariseFindings, findingsOf, type SweepPoFindings } from "./sweep";
import { CHECK_ROW_KINDS, type CheckRow, type CheckRowKind, type CheckSection } from "./po-checks";
import type { PoChecksReport } from "./run-po-checks";

// Every name here is invented. The repo is public; no live PO, style or
// supplier goes into a fixture.

let seq = 0;
function finding(kind: CheckRowKind, over: Partial<CheckRow> = {}): CheckRow & { checkId: "cover-pages" } {
  seq += 1;
  return {
    id: `item-${seq}`,
    fileName: `file-${seq}.pdf`,
    webUrl: null,
    size: 1,
    lastModifiedAt: null,
    location: "approved-layouts",
    kind,
    verdict: "flagged",
    detail: null,
    owner: null,
    proposed: null,
    allowed: [],
    renameTo: null,
    checkId: "cover-pages",
    ...over,
  };
}

function po(poNumber: string, findings: Array<ReturnType<typeof finding>>): SweepPoFindings {
  return { supplierId: "sup-1", poNumber, poSeq: 1, supplierName: null, folderUrl: null, findings };
}

test("the rollup is by FAULT, not by folder — that is the whole point", () => {
  const groups = groupFindings([
    po("PO-1", [finding("cover-renamed"), finding("cover-renamed")]),
    po("PO-2", [finding("cover-renamed"), finding("layout-id-orphan")]),
  ]);
  const renamed = groups.find((g) => g.kind === "cover-renamed")!;
  assert.equal(renamed.files, 3, "three files across the book");
  assert.equal(renamed.pos, 2, "in two orders");
  assert.equal(groups.find((g) => g.kind === "layout-id-orphan")!.pos, 1);
});

test("a PO counted once per group however many files it contributes", () => {
  const groups = groupFindings([po("PO-1", [finding("file-renamed"), finding("file-renamed"), finding("file-renamed")])]);
  assert.equal(groups[0].files, 3);
  assert.equal(groups[0].pos, 1);
});

test("mechanical repairs are counted apart from judgement calls", () => {
  // The distinction an operator plans around: 'all renames' is an afternoon,
  // 'all unexplained' is a conversation.
  const groups = groupFindings([
    po("PO-1", [
      finding("file-renamed", { allowed: ["rename", "delete"], renameTo: "right-name.pdf", proposed: "rename" }),
      finding("cover-not-ours", { allowed: ["delete"] }),
      finding("layout-id-no-file-name", { allowed: [] }),
    ]),
  ]);
  assert.equal(groups.find((g) => g.kind === "file-renamed")!.renameable, 1);
  assert.equal(groups.find((g) => g.kind === "cover-not-ours")!.renameable, 0);
  assert.equal(groups.find((g) => g.kind === "cover-not-ours")!.deletable, 1);
  assert.equal(groups.find((g) => g.kind === "layout-id-no-file-name")!.deletable, 0);
});

test("repairable defects sort above judgement calls, and volume breaks ties", () => {
  const groups = groupFindings([
    po("PO-1", [finding("cover-not-ours"), finding("cover-not-ours"), finding("cover-not-ours")]),
    po("PO-2", [finding("file-renamed")]),
  ]);
  assert.equal(groups[0].kind, "file-renamed", "a known repair leads even when it is rarer");
  assert.equal(groups[1].kind, "cover-not-ours");
});

test("the order is stable across two identical rollups", () => {
  const rows = [
    po("PO-1", [finding("file-renamed"), finding("cover-not-ours")]),
    po("PO-2", [finding("file-superseded")]),
  ];
  assert.deepEqual(groupFindings(rows).map((g) => g.kind), groupFindings(rows).map((g) => g.kind));
});

test("every kind a check can emit has a group heading", () => {
  // A kind with no entry would render as a raw identifier on the page.
  const kinds: CheckRowKind[] = [
    "cover-expected", "cover-superseded", "cover-renamed", "cover-unrecognised",
    "cover-foreign", "cover-not-ours", "file-expected", "file-superseded",
    "file-renamed", "file-not-ours", "layout-id-no-file-name",
    "layout-id-renameable", "layout-id-orphan",
  ];
  for (const k of kinds) assert.ok(CHECK_ROW_KINDS[k]?.title, `${k} has no heading`);
});

test("only FLAGGED rows are collected — the coverage half is never a finding", () => {
  const section = (id: CheckSection["id"], flagged: CheckRow[], ok: CheckRow[]): CheckSection => ({
    id, title: id, description: "", scanned: flagged.length + ok.length, flagged, ok, notes: [],
  });
  const report = {
    sections: [
      section("cover-pages", [finding("cover-renamed")], [finding("cover-expected")]),
      section("output-file-names", [finding("file-renamed")], [finding("file-expected")]),
    ],
  } as unknown as PoChecksReport;
  const rows = findingsOf(report);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.checkId), ["cover-pages", "output-file-names"]);
  assert.deepEqual(rows.map((r) => r.kind), ["cover-renamed", "file-renamed"]);
});

test("the stored per-PO histogram rolls up to exactly the same answer", () => {
  // The progress poll reads the histograms, not the rows. If the two ever
  // disagreed the page would show one number and the group another.
  const rows = [
    po("PO-1", [
      finding("file-renamed", { allowed: ["rename", "delete"] }),
      finding("file-renamed", { allowed: ["rename", "delete"] }),
      finding("cover-not-ours", { allowed: ["delete"] }),
    ]),
    po("PO-2", [finding("file-renamed", { allowed: ["rename", "delete"] }), finding("layout-id-no-file-name")]),
  ];
  assert.deepEqual(groupHistograms(rows.map((r) => summariseFindings(r.findings))), groupFindings(rows));
});

test("a PO with nothing flagged contributes no group at all", () => {
  assert.deepEqual(groupHistograms([{}, {}]), []);
});
