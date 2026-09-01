// The deletion-safety guards on the ONLY thing in the checks feature that
// writes. This is the first surface in the app that deletes from SharePoint, so
// each rule gets a test that FAILS LOUDLY if it is ever relaxed:
//
//   • nothing is acted on from the report the user was shown — the check is
//     re-run and every request validated against the live folder;
//   • only rows the FRESH check flagged, only the action that row allows, only
//     the rename target the layout's own template resolved;
//   • never outside APPROVED LAYOUTS, never a folder, never in unbounded bulk;
//   • every attempt is recorded, including the refusals.
//
// Graph is spied, never called. Requires Node's module-mock API:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CheckRow, CheckSection } from "../src/lib/checks/po-checks";

// ── The live folder the apply re-checks against ─────────────────────────────
function row(over: Partial<CheckRow> & { id: string; fileName: string }): CheckRow {
  return {
    webUrl: null,
    size: 1,
    lastModifiedAt: null,
    location: "approved-layouts",
    verdict: "flagged for a reason",
    detail: null,
    owner: null,
    proposed: "delete",
    allowed: ["delete"],
    renameTo: null,
    ...over,
  };
}

function section(id: CheckSection["id"], flagged: CheckRow[], ok: CheckRow[] = []): CheckSection {
  return { id, title: id, description: "", scanned: flagged.length + ok.length, flagged, ok, notes: [] };
}

let freshReport: Record<string, unknown>;
function setFolder(sections: CheckSection[], state = "ok") {
  freshReport = {
    poNumber: "PO-TEST-1",
    supplierId: "sup-1",
    supplierName: "Supplier One",
    state,
    message: "message for state " + state,
    folderUrl: "https://example.invalid/folder",
    poFolderUrl: null,
    folderPath: "PO folder / APPROVED LAYOUTS",
    styles: [],
    sections,
    checkedAt: new Date().toISOString(),
  };
}

// ── Graph spies ─────────────────────────────────────────────────────────────
const deleteDriveItem = mock.fn(async () => ({ deleted: true, alreadyGone: false }));
const renameDriveItem = mock.fn(async () => ({ renamed: true, webUrl: null }));
const runPoChecksResolved = mock.fn(async () => ({
  report: freshReport,
  target: { driveId: "drive-1", leafItemId: "leaf-1", poFolderItemId: "po-1", state: "ok" },
}));
const createMany = mock.fn(async () => ({ count: 0 }));

class SharePointWriteForbiddenError extends Error {}

before(() => {
  mock.module("@/lib/sharepoint/supplier-folder", {
    namedExports: { deleteDriveItem, renameDriveItem, SharePointWriteForbiddenError },
  });
  mock.module("@/lib/checks/run-po-checks", { namedExports: { runPoChecksResolved } });
  mock.module("@/lib/db", {
    namedExports: { db: { folderCheckAction: { createMany, findMany: async () => [] } } },
  });
});

beforeEach(() => {
  deleteDriveItem.mock.resetCalls();
  renameDriveItem.mock.resetCalls();
  runPoChecksResolved.mock.resetCalls();
  createMany.mock.resetCalls();
});

const apply = async (actions: unknown[]) => {
  const { applyCheckActions } = await import("../src/lib/checks/apply-actions");
  return applyCheckActions({
    supplierId: "sup-1",
    poNumber: "PO-TEST-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: actions as any,
    userId: "user-1",
    userEmail: "reviewer@example.com",
  });
};

const del = (itemId: string, fileName: string) => ({
  checkId: "cover-pages" as const,
  itemId,
  fileName,
  action: "delete" as const,
});

test("the check is re-run against the live folder before anything is touched", async () => {
  setFolder([section("cover-pages", [row({ id: "i1", fileName: "a.pdf" })])]);
  await apply([del("i1", "a.pdf")]);
  assert.ok(runPoChecksResolved.mock.callCount() >= 1, "the folder must be re-read, never trusted from the client");
  assert.equal(deleteDriveItem.mock.callCount(), 1);
  assert.deepEqual(deleteDriveItem.mock.calls[0].arguments, ["drive-1", "i1"]);
});

test("a file the fresh check no longer flags is REFUSED", async () => {
  // The reason the re-check exists: between the scan and the click an output
  // can be re-run and a stale row can become the only good copy.
  setFolder([section("cover-pages", [])]);
  const res = await apply([del("i1", "a.pdf")]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
});

test("a file that is now in the LOOKS-RIGHT group is refused, not deleted", async () => {
  setFolder([section("cover-pages", [], [row({ id: "i1", fileName: "a.pdf" })])]);
  const res = await apply([del("i1", "a.pdf")]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
});

test("a file renamed since the scan is refused — the name has to still match", async () => {
  setFolder([section("cover-pages", [row({ id: "i1", fileName: "renamed-since.pdf" })])]);
  const res = await apply([del("i1", "a.pdf")]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
  assert.match(res.applied[0].message, /now called/);
});

test("an action the row does not allow is refused", async () => {
  setFolder([
    section("cover-pages", [row({ id: "i1", fileName: "a.pdf", proposed: null, allowed: [] })]),
  ]);
  const res = await apply([del("i1", "a.pdf")]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
});

test("a row outside APPROVED LAYOUTS can never be acted on", async () => {
  setFolder([
    section("cover-pages", [
      row({ id: "i1", fileName: "a.pdf", location: "po-folder", allowed: ["delete"], proposed: "delete" }),
    ]),
  ]);
  const res = await apply([del("i1", "a.pdf")]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
  assert.match(res.applied[0].message, /APPROVED LAYOUTS/);
});

test("the client does not get to choose the new name", async () => {
  setFolder([
    section("output-file-names", [
      row({ id: "i1", fileName: "old.pdf", proposed: "rename", allowed: ["rename"], renameTo: "correct.pdf" }),
    ]),
  ]);
  const res = await apply([
    { checkId: "output-file-names", itemId: "i1", fileName: "old.pdf", action: "rename", newName: "whatever.pdf" },
  ]);
  assert.equal(renameDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");

  renameDriveItem.mock.resetCalls();
  const ok = await apply([
    { checkId: "output-file-names", itemId: "i1", fileName: "old.pdf", action: "rename", newName: "correct.pdf" },
  ]);
  assert.equal(ok.applied[0].outcome, "done");
  assert.deepEqual(renameDriveItem.mock.calls[0].arguments, ["drive-1", "i1", "correct.pdf"]);
});

test("the check id is part of the row's identity — a request cannot cross checks", async () => {
  setFolder([section("cover-pages", [row({ id: "i1", fileName: "a.pdf" })])]);
  const res = await apply([{ checkId: "output-file-names", itemId: "i1", fileName: "a.pdf", action: "delete" }]);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
  assert.equal(res.applied[0].outcome, "refused");
});

test("an unreadable folder is never a licence to delete", async () => {
  // A 403 or a throttle must not read as "these files are unrecognised".
  for (const state of ["unavailable", "po-folder-ambiguous", "subfolder-missing"]) {
    setFolder([section("cover-pages", [row({ id: "i1", fileName: "a.pdf" })])], state);
    await assert.rejects(() => apply([del("i1", "a.pdf")]), /message for state/);
  }
  assert.equal(deleteDriveItem.mock.callCount(), 0);
});

test("bulk is bounded — a runaway batch is refused before the folder is even read", async () => {
  const { MAX_ACTIONS_PER_REQUEST } = await import("../src/lib/checks/apply-actions");
  setFolder([section("cover-pages", [row({ id: "i1", fileName: "a.pdf" })])]);
  const many = Array.from({ length: MAX_ACTIONS_PER_REQUEST + 1 }, (_, i) => del(`i${i}`, `f${i}.pdf`));
  await assert.rejects(() => apply(many), /at most/);
  assert.equal(runPoChecksResolved.mock.callCount(), 0);
  assert.equal(deleteDriveItem.mock.callCount(), 0);
});

test("an empty request is refused rather than treated as a no-op apply", async () => {
  setFolder([section("cover-pages", [])]);
  await assert.rejects(() => apply([]), /No files were selected/);
});

test("every attempt is recorded — the refusals too, with the verdict shown", async () => {
  setFolder([
    section("cover-pages", [
      row({ id: "i1", fileName: "a.pdf", verdict: "a cover for a style not on this PO" }),
    ]),
  ]);
  await apply([del("i1", "a.pdf"), del("gone", "vanished.pdf")]);
  assert.equal(createMany.mock.callCount(), 1);
  const { data } = createMany.mock.calls[0].arguments[0] as {
    data: Array<{ outcome: string; verdict: string | null; userEmail: string | null; driveItemId: string }>;
  };
  assert.equal(data.length, 2, "the refusal is audited exactly like the deletion");
  const done = data.find((d) => d.driveItemId === "i1")!;
  assert.equal(done.outcome, "done");
  assert.equal(done.verdict, "a cover for a style not on this PO");
  assert.equal(done.userEmail, "reviewer@example.com");
  assert.equal(data.find((d) => d.driveItemId === "gone")!.outcome, "refused");
});

test("one file failing does not abandon the rest of the batch", async () => {
  setFolder([
    section("cover-pages", [row({ id: "i1", fileName: "a.pdf" }), row({ id: "i2", fileName: "b.pdf" })]),
  ]);
  let call = 0;
  deleteDriveItem.mock.mockImplementation(async () => {
    call += 1;
    if (call === 1) throw new SharePointWriteForbiddenError("403");
    return { deleted: true, alreadyGone: false };
  });
  const res = await apply([del("i1", "a.pdf"), del("i2", "b.pdf")]);
  assert.equal(res.failed, 1);
  assert.equal(res.done, 1);
  deleteDriveItem.mock.restore();
});
