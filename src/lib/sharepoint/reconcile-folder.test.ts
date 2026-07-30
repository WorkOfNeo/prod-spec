// Pure-logic tests for the per-style folder reconcile. There is no SharePoint
// and no database in CI, so the module keeps its decision logic — the diff, the
// hand-rename similarity matcher and the unresolvable-state precedence — as
// pure functions over plain data, and this file exercises exactly those.
//
// What is being protected here:
//   • the UNEXPECTED direction, which nothing else in the codebase computes —
//     get it wrong and hand-renamed files stay invisible;
//   • the rename similarity, because a wrong guess is what would tempt someone
//     to "just adopt it" onto the wrong output;
//   • state precedence, because reporting "missing" for a folder we could not
//     read would tell users their approved artwork vanished when it did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffFolderContents,
  fileExtension,
  fileNameSimilarity,
  matchRenames,
  normalizeFileNameForCompare,
  precheckReconcileState,
  reconcileStateMessage,
  RENAME_MATCH_THRESHOLD,
  type ExpectedFile,
  type PresentFile,
} from "./reconcile-folder";

// --- fixtures -------------------------------------------------------------

// An expected file with sane defaults; `over` names the bits a test cares about.
const expected = (fileName: string, over: Partial<ExpectedFile> = {}): ExpectedFile => ({
  fileName,
  storedFileName: fileName,
  variantKey: over.variantKey ?? `layout:${fileName}`,
  baseKey: over.baseKey ?? over.variantKey?.split("#")[0] ?? `layout:${fileName}`,
  name: over.name ?? fileName.replace(/\.pdf$/i, ""),
  docType: "OTHER",
  jobAssetId: `asset-${fileName}`,
  queueItemId: `queue-${fileName}`, // queued by default — notQueued is the exception
  queueStatus: "UPLOADED",
  ...over,
});

const present = (name: string, over: Partial<PresentFile> = {}): PresentFile => ({
  name,
  itemId: `item-${name}`,
  webUrl: `https://sp/${name}`,
  size: 1024,
  lastModifiedAt: "2026-07-01T10:00:00Z",
  ...over,
});

// --- normalisation + similarity ------------------------------------------

test("fileExtension — lowercased extension, and a dotfile has none", () => {
  assert.equal(fileExtension("Wash care label (DE).PDF"), ".pdf");
  assert.equal(fileExtension("no-extension"), "");
  assert.equal(fileExtension(".gitkeep"), "", "a leading dot is a dotfile, not an extension");
});

test("normalizeFileNameForCompare — drops case, extension and punctuation runs", () => {
  assert.equal(normalizeFileNameForCompare("Wash care label (DE).pdf"), "wash care label de");
  assert.equal(
    normalizeFileNameForCompare("00077180-L-Inner_Pack.pdf"),
    "00077180 l inner pack",
    "hyphens and underscores collapse to the same separator",
  );
  assert.equal(normalizeFileNameForCompare("  spaced  out .pdf"), "spaced out");
});

test("fileNameSimilarity — an appended word is a near-certain rename", () => {
  // The operator's actual case: a human adds "FINAL" after approval.
  const s = fileNameSimilarity("Wash care label (DE).pdf", "Wash care label (DE) FINAL.pdf");
  assert.ok(s > 0.85, `expected a high score, got ${s}`);
});

test("fileNameSimilarity — reflowed separators / a typo still score high", () => {
  // Token overlap breaks here (the tokens change), edit distance carries it —
  // which is exactly why the score is the MAX of the two measures.
  const s = fileNameSimilarity("Wash care label (DE).pdf", "Wash-care-labell-DE.pdf");
  assert.ok(s > RENAME_MATCH_THRESHOLD, `expected above threshold, got ${s}`);
});

test("fileNameSimilarity — unrelated outputs score far below the threshold", () => {
  const s = fileNameSimilarity("Wash care label (DE).pdf", "Carton marking.pdf");
  assert.ok(s < RENAME_MATCH_THRESHOLD, `expected below threshold, got ${s}`);
});

test("fileNameSimilarity — identical names score 1, different extensions score 0", () => {
  assert.equal(fileNameSimilarity("a b.pdf", "A B.PDF"), 1, "case/extension case only");
  assert.equal(
    fileNameSimilarity("Wash care label.pdf", "Wash care label.zip"),
    0,
    "a PDF output is never the ZIP someone dropped in the folder",
  );
});

test("matchRenames — pairs the best candidate and never reuses a name", () => {
  const matches = matchRenames(
    ["Wash care label (DE).pdf", "Carton marking.pdf"],
    ["Wash care label (DE) FINAL.pdf", "Carton marking v2.pdf"],
  );
  assert.equal(matches.length, 2);
  const byMissing = new Map(matches.map((m) => [m.missing, m.unexpected]));
  assert.equal(byMissing.get("Wash care label (DE).pdf"), "Wash care label (DE) FINAL.pdf");
  assert.equal(byMissing.get("Carton marking.pdf"), "Carton marking v2.pdf");
});

test("matchRenames — one unexpected file can only be one output's rename", () => {
  // Two missing outputs, one candidate: the better-scoring one takes it, the
  // other is left unmatched rather than both claiming the same file.
  const matches = matchRenames(
    ["Wash care label (DE).pdf", "Wash care label (DK).pdf"],
    ["Wash care label (DE) FINAL.pdf"],
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].missing, "Wash care label (DE).pdf");
});

test("matchRenames — nothing plausible means no guess at all (never force a pair)", () => {
  assert.deepEqual(matchRenames(["Wash care label (DE).pdf"], ["supplier-invoice-2026.pdf"]), []);
});

test("matchRenames — deterministic on ties, so a re-check doesn't reshuffle", () => {
  const a = matchRenames(["b.pdf", "a.pdf"], ["b copy.pdf", "a copy.pdf"]);
  const b = matchRenames(["a.pdf", "b.pdf"], ["a copy.pdf", "b copy.pdf"]);
  assert.deepEqual(
    a.map((m) => `${m.missing}→${m.unexpected}`).sort(),
    b.map((m) => `${m.missing}→${m.unexpected}`).sort(),
  );
});

// --- the diff -------------------------------------------------------------

test("diffFolderContents — everything present is ok, nothing else is reported", () => {
  const diff = diffFolderContents({
    expected: [expected("a.pdf"), expected("b.pdf")],
    present: [present("a.pdf"), present("b.pdf")],
  });
  assert.equal(diff.ok.length, 2);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.unexpected, []);
  assert.deepEqual(diff.notQueued, []);
  assert.equal(diff.ok[0].itemId, "item-a.pdf", "ok rows carry the Graph item id + link");
});

test("diffFolderContents — matching is case-insensitive (SharePoint folders are)", () => {
  const diff = diffFolderContents({
    expected: [expected("Wash Care Label.pdf")],
    present: [present("wash care label.pdf")],
  });
  assert.equal(diff.ok.length, 1);
  assert.equal(diff.missing.length, 0);
});

test("diffFolderContents — matches against the SANITISED name the push writes", () => {
  // The real bug this guards: an Output-Builder key carries a colon, which
  // SharePoint forbids, so the push writes it as a hyphen. Comparing the raw
  // stored name would report a perfectly good file as missing forever.
  const diff = diffFolderContents({
    expected: [expected("mg30019-layout:cmrde40im012r-Navy.pdf")],
    present: [present("mg30019-layout-cmrde40im012r-Navy.pdf")],
  });
  assert.equal(diff.ok.length, 1, "colon-bearing expected name matches its sanitised upload");
  assert.equal(diff.missing.length, 0);
});

test("diffFolderContents — an expected file that isn't there is missing", () => {
  const diff = diffFolderContents({
    expected: [expected("a.pdf"), expected("b.pdf")],
    present: [present("a.pdf")],
  });
  assert.deepEqual(diff.missing.map((m) => m.fileName), ["b.pdf"]);
  assert.equal(diff.missing[0].queued, true);
  assert.equal(diff.missing[0].queueItemId, "queue-b.pdf", "carries the row to re-arm");
});

test("diffFolderContents — a file nothing accounts for is UNEXPECTED (the new signal)", () => {
  const diff = diffFolderContents({
    expected: [expected("a.pdf")],
    present: [present("a.pdf"), present("supplier-own-notes.pdf")],
  });
  assert.deepEqual(diff.unexpected.map((u) => u.fileName), ["supplier-own-notes.pdf"]);
  assert.equal(diff.unexpected[0].itemId, "item-supplier-own-notes.pdf");
  assert.equal(
    diff.unexpected[0].likelyRenamedFrom,
    null,
    "an unrelated file is reported, but not blamed on any output",
  );
});

test("diffFolderContents — a hand-rename shows up as BOTH a missing and an unexpected, cross-linked", () => {
  // The operator's whole complaint: renamed AFTER approval, so no re-upload.
  const diff = diffFolderContents({
    expected: [expected("Wash care label (DE).pdf", { name: "Wash care label (DE)", variantKey: "layout:wc#de" })],
    present: [present("Wash care label (DE) FINAL.pdf")],
  });
  assert.equal(diff.missing.length, 1);
  assert.equal(diff.unexpected.length, 1);

  assert.equal(diff.missing[0].likelyRenamedTo?.fileName, "Wash care label (DE) FINAL.pdf");
  assert.equal(diff.missing[0].likelyRenamedTo?.itemId, "item-Wash care label (DE) FINAL.pdf");
  assert.equal(diff.unexpected[0].likelyRenamedFrom?.fileName, "Wash care label (DE).pdf");
  assert.equal(diff.unexpected[0].likelyRenamedFrom?.variantKey, "layout:wc#de");
  assert.ok(
    (diff.unexpected[0].likelyRenamedFrom?.confidence ?? 0) > 0.85,
    "the confidence is reported so a human can decide — nothing is applied on it",
  );
});

test("diffFolderContents — notQueued flags a config-expected output with no queue row", () => {
  // The structural gap: an output added to the ProdSpec AFTER approval has no
  // SupplierSendQueueItem, so the verify sweep has nothing to scan and is blind
  // to it. It is deliberately reported as BOTH missing and notQueued — each
  // calls for a different repair (re-arm a row vs. there is no row to re-arm).
  const diff = diffFolderContents({
    expected: [
      expected("a.pdf"),
      expected("late-addition.pdf", { queueItemId: null, queueStatus: null }),
    ],
    present: [present("a.pdf")],
  });
  assert.deepEqual(diff.notQueued.map((n) => n.fileName), ["late-addition.pdf"]);
  assert.equal(diff.notQueued[0].present, false);
  assert.deepEqual(diff.missing.map((m) => m.fileName), ["late-addition.pdf"]);
  assert.equal(diff.missing[0].queued, false, "missing row says there is no row to re-arm");
});

test("diffFolderContents — a never-queued output that IS in the folder is notQueued but not missing", () => {
  // Someone pushed it by hand; the queue simply never learned about it.
  const diff = diffFolderContents({
    expected: [expected("pushed-by-hand.pdf", { queueItemId: null, queueStatus: null })],
    present: [present("pushed-by-hand.pdf")],
  });
  assert.equal(diff.ok.length, 1);
  assert.deepEqual(diff.missing, []);
  assert.equal(diff.notQueued.length, 1);
  assert.equal(diff.notQueued[0].present, true);
});

test("diffFolderContents — an empty folder reports every expected file missing, none unexpected", () => {
  const diff = diffFolderContents({ expected: [expected("a.pdf"), expected("b.pdf")], present: [] });
  assert.equal(diff.missing.length, 2);
  assert.equal(diff.unexpected.length, 0);
});

test("diffFolderContents — an empty config makes every file unexpected, none missing", () => {
  const diff = diffFolderContents({ expected: [], present: [present("a.pdf"), present("b.pdf")] });
  assert.equal(diff.unexpected.length, 2);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.notQueued.length, 0);
});

test("diffFolderContents — every document of a split output is diffed separately", () => {
  // A carton X-of-Y is several PDFs behind ONE queue row (rows are keyed by the
  // base slot), so both documents must share that row's id — otherwise only one
  // of them could ever be re-armed.
  const diff = diffFolderContents({
    expected: [
      expected("carton-S.pdf", { variantKey: "layout:carton#S", baseKey: "layout:carton", queueItemId: "q-slot" }),
      expected("carton-M.pdf", { variantKey: "layout:carton#M", baseKey: "layout:carton", queueItemId: "q-slot" }),
    ],
    present: [present("carton-S.pdf")],
  });
  assert.equal(diff.ok.length, 1);
  assert.deepEqual(diff.missing.map((m) => m.variantKey), ["layout:carton#M"]);
  assert.equal(diff.missing[0].queueItemId, "q-slot");
});

// --- state precedence -----------------------------------------------------

test("precheckReconcileState — nothing blocking returns null (go to Graph)", () => {
  assert.equal(
    precheckReconcileState({
      styleFound: true,
      hasSupplier: true,
      supplierFolderUrl: "https://sp/supplier",
      poNumber: "C-PO63394",
      skipSupplierDelivery: false,
      sharepointConfigured: true,
    }),
    null,
  );
});

test("precheckReconcileState — reports the FIRST broken link in the chain", () => {
  // A style with nothing set must say "no supplier", not "no PO": sending
  // someone to set a PO when there is no supplier to send it to is the wrong
  // repair. The order mirrors countPoFolderFiles so the two panels agree.
  const nothingSet = {
    styleFound: true,
    hasSupplier: false,
    supplierFolderUrl: null,
    poNumber: null,
    skipSupplierDelivery: false,
    sharepointConfigured: false,
  };
  assert.equal(precheckReconcileState(nothingSet), "no-supplier");
  assert.equal(precheckReconcileState({ ...nothingSet, hasSupplier: true }), "no-supplier-folder");
  assert.equal(
    precheckReconcileState({ ...nothingSet, hasSupplier: true, supplierFolderUrl: "https://sp/x" }),
    "no-po",
  );
  assert.equal(
    precheckReconcileState({
      ...nothingSet,
      hasSupplier: true,
      supplierFolderUrl: "https://sp/x",
      poNumber: "C-PO1",
    }),
    "not-configured",
  );
});

test("precheckReconcileState — a missing style outranks everything", () => {
  assert.equal(
    precheckReconcileState({
      styleFound: false,
      hasSupplier: true,
      supplierFolderUrl: "https://sp/x",
      poNumber: "C-PO1",
      skipSupplierDelivery: false,
      sharepointConfigured: true,
    }),
    "style-not-found",
  );
});

test("precheckReconcileState — skip-supplier-delivery beats the SharePoint config check", () => {
  // The customer delivers its own goods, so nothing belongs in a supplier
  // folder — true whether or not Graph happens to be configured here.
  assert.equal(
    precheckReconcileState({
      styleFound: true,
      hasSupplier: true,
      supplierFolderUrl: "https://sp/x",
      poNumber: "C-PO1",
      skipSupplierDelivery: true,
      sharepointConfigured: false,
    }),
    "skip-delivery",
  );
});

test("precheckReconcileState — a blank folder link / PO counts as absent", () => {
  const base = {
    styleFound: true,
    hasSupplier: true,
    supplierFolderUrl: "   ",
    poNumber: "C-PO1",
    skipSupplierDelivery: false,
    sharepointConfigured: true,
  };
  assert.equal(precheckReconcileState(base), "no-supplier-folder");
  assert.equal(
    precheckReconcileState({ ...base, supplierFolderUrl: "https://sp/x", poNumber: "  " }),
    "no-po",
  );
});

test("reconcileStateMessage — an unreadable folder never claims files are gone", () => {
  const msg = reconcileStateMessage("unavailable");
  assert.match(msg, /not evidence that a file is gone/i);
  // And the folder-shaped refusals say what a human has to do about them.
  assert.match(reconcileStateMessage("po-folder-ambiguous", { poNumber: "C-PO1" }), /exactly one/i);
  assert.match(reconcileStateMessage("po-folder-missing"), /never creates the PO folder/i);
});
