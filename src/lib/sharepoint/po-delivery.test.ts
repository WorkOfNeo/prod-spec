// Pure-logic tests for the PO delivery ledger. No SharePoint and no database in
// CI, so the counting — which is the entire reason this module exists — is a
// pure function over plain data and this file exercises exactly that.
//
// What is being protected:
//   • COUNTING vs set membership. Two documents wanting one file name both
//     "match" the single file the folder can hold, and a set diff calls both
//     delivered while one of them has been overwritten out of existence. Every
//     collision test here is guarding that specific silent data loss.
//   • The PO as the unit. A style with nothing delivered has to be visible in
//     the roll-up, because that is the case nobody finds by opening styles.
//   • stray vs stale. One is the supplier's own file and must be left alone;
//     the other is ours and is removable once nothing needs it. Confusing them
//     means deleting a customer's artwork.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryLedger,
  describeDistinguishers,
  deliveryHeadline,
  isFullyDelivered,
  type DeliveryFile,
  type DeliveryDocument,
} from "./po-delivery";
import type { ExpectedFile } from "./reconcile-folder";

// --- fixtures -------------------------------------------------------------

let seq = 0;
const doc = (fileName: string, over: Partial<ExpectedFile> = {}): ExpectedFile => ({
  fileName,
  storedFileName: over.storedFileName ?? fileName,
  previousFileName: over.previousFileName ?? null,
  currentStoredFileName: fileName,
  nameNote: null,
  variantKey: over.variantKey ?? `layout:x#${(seq += 1)}`,
  baseKey: (over.variantKey ?? "layout:x").split("#")[0],
  name: over.name ?? "Wash care label",
  docType: "OTHER",
  jobAssetId: over.jobAssetId ?? `asset-${(seq += 1)}`,
  queueItemId: null,
  queueStatus: null,
  styleId: over.styleId ?? "style-a",
  styleName: over.styleName ?? "STYLE-A",
  isSelf: true,
  ...over,
});

const file = (fileName: string): DeliveryFile => ({
  fileName,
  itemId: `item-${fileName}`,
  webUrl: null,
  size: 1024,
  lastModifiedAt: null,
});

// --- the core: counting, not set membership -------------------------------

test("two documents wanting ONE name: the folder holds one, the other is lost", () => {
  // The failure a set-based diff cannot see. Both documents "match" the single
  // file, so a set diff reports 2 delivered and no problem at all.
  const ledger = buildDeliveryLedger({
    expected: [
      doc("EV-S-Care-Label.pdf", { styleId: "s1", styleName: "EV30068", variantKey: "layout:care#S-Grnn" }),
      doc("EV-S-Care-Label.pdf", { styleId: "s2", styleName: "EV30068", variantKey: "layout:care#S-Rd" }),
    ],
    present: [file("EV-S-Care-Label.pdf")],
  });

  assert.equal(ledger.totals.expectedDocs, 2);
  assert.equal(ledger.totals.deliveredDocs, 1, "the folder can only hold one file under one name");
  assert.equal(ledger.totals.collisionDocs, 1, "so exactly one document is undeliverable");
  assert.equal(ledger.totals.collisionNames, 1);
  assert.deepEqual(
    ledger.documents.map((d) => d.status),
    ["colliding", "colliding"],
    "neither may claim 'delivered' — we cannot tell which one survived",
  );
});

test("a collision is a collision even when the name is absent entirely", () => {
  // Nothing landed yet, but re-pushing both would still leave one. The naming
  // defect exists independently of whether a transfer happened.
  const ledger = buildDeliveryLedger({
    expected: [doc("clash.pdf", { styleId: "s1" }), doc("clash.pdf", { styleId: "s2" })],
    present: [],
  });
  assert.equal(ledger.totals.missingDocs, 2);
  assert.equal(ledger.totals.collisionDocs, 1, "one of the two can never land under this naming");
  assert.equal(ledger.totals.deliveredDocs, 0);
});

test("three documents on one name lose two of them", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("x.pdf", { styleId: "a" }), doc("x.pdf", { styleId: "b" }), doc("x.pdf", { styleId: "c" })],
    present: [file("x.pdf")],
  });
  assert.equal(ledger.totals.collisionDocs, 2);
  assert.equal(ledger.totals.deliveredDocs, 1);
});

test("distinct names for the same documents deliver all of them", () => {
  // The fix for a collision: make the template specific enough. Same two
  // documents, now distinguishable, and both land.
  const ledger = buildDeliveryLedger({
    expected: [doc("EV-S-Grnn-Care.pdf", { styleId: "s1" }), doc("EV-S-Rd-Care.pdf", { styleId: "s2" })],
    present: [file("EV-S-Grnn-Care.pdf"), file("EV-S-Rd-Care.pdf")],
  });
  assert.equal(ledger.totals.collisionDocs, 0);
  assert.equal(ledger.totals.deliveredDocs, 2);
  assert.ok(isFullyDelivered(ledger.totals));
});

// --- what differs: the actionable half of a collision ---------------------

test("describeDistinguishers names the shared style number, the nastiest shape", () => {
  const ledger = buildDeliveryLedger({
    expected: [
      doc("c.pdf", { styleId: "s1", styleName: "EV30068", variantKey: "layout:carton#L-Grnn" }),
      doc("c.pdf", { styleId: "s2", styleName: "EV30068", variantKey: "layout:carton#L-Rd" }),
    ],
    present: [file("c.pdf")],
  });
  const group = ledger.names.find((g) => g.wanted > 1);
  assert.match(group!.distinguishers[0], /share the style number/);
  assert.match(group!.distinguishers[1], /L-Grnn, L-Rd/, "and the split rows that would separate them");
});

// describeDistinguishers takes the ledger's own row shape, so build those
// directly rather than reusing `doc` (whose variant keys deliberately differ).
const row = (over: Partial<DeliveryDocument> = {}): DeliveryDocument => ({
  styleId: "s1",
  styleName: "STYLE-A",
  variantKey: "layout:care#S-Grnn",
  name: "Wash care label",
  docType: "OTHER",
  jobAssetId: "asset-1",
  fileName: "d.pdf",
  previousFileName: null,
  status: "colliding",
  queueItemId: null,
  queueStatus: null,
  ...over,
});

test("describeDistinguishers says so when NOTHING distinguishes them", () => {
  // Same style, same split row, twice — a duplicate document, not an ambiguous
  // template. The repair is different, so the message must be too.
  const out = describeDistinguishers([row({ jobAssetId: "a" }), row({ jobAssetId: "b" })]);
  assert.deepEqual(out, ["nothing distinguishes them — these look like duplicate documents"]);
});

test("describeDistinguishers separates two different OUTPUTS on one name", () => {
  const out = describeDistinguishers([
    row({ variantKey: "layout:care", name: "Wash care label" }),
    row({ variantKey: "layout:inner", name: "Inner pack sticker" }),
  ]);
  assert.match(out.join(" "), /different outputs \(Wash care label, Inner pack sticker\)/);
});

test("describeDistinguishers is empty for a name only one document wants", () => {
  assert.deepEqual(describeDistinguishers([row()]), []);
});

// --- renamed vs missing ---------------------------------------------------

test("present under the OLD name is 'renamed', not missing", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("new.pdf", { storedFileName: "old.pdf", previousFileName: "old.pdf" })],
    present: [file("old.pdf")],
  });
  assert.equal(ledger.totals.renamedDocs, 1);
  assert.equal(ledger.totals.missingDocs, 0);
  assert.equal(ledger.totals.deliveredDocs, 0, "it is not delivered — the supplier can't find it by the right name");
  assert.equal(ledger.names[0].presentAsPrevious, true);
});

test("neither name present is missing", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("new.pdf", { storedFileName: "old.pdf", previousFileName: "old.pdf" })],
    present: [],
  });
  assert.equal(ledger.totals.missingDocs, 1);
  assert.equal(ledger.totals.renamedDocs, 0);
});

// --- stray vs stale: which files may we touch -----------------------------

test("a file under someone's OLD name is stale (ours); anything else is a stray", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("new.pdf", { storedFileName: "old.pdf", previousFileName: "old.pdf" })],
    present: [file("old.pdf"), file("EVX00031 - Hangtag.pdf")],
  });
  assert.deepEqual(ledger.staleFiles.map((f) => f.fileName), ["old.pdf"]);
  assert.deepEqual(
    ledger.strayFiles.map((f) => f.fileName),
    ["EVX00031 - Hangtag.pdf"],
    "a supplier's own upload is never ours to delete",
  );
});

test("a delivered file is neither stray nor stale", () => {
  const ledger = buildDeliveryLedger({ expected: [doc("a.pdf")], present: [file("a.pdf")] });
  assert.equal(ledger.strayFiles.length, 0);
  assert.equal(ledger.staleFiles.length, 0);
});

// --- the PO is the unit ---------------------------------------------------

test("a style with NOTHING delivered is visible in the roll-up", () => {
  // The case that motivated the whole surface: two styles look fine, a third
  // has zero files, and nobody opening either of the first two would ever know.
  const ledger = buildDeliveryLedger({
    expected: [
      doc("a1.pdf", { styleId: "s1", styleName: "EV30068" }),
      doc("a2.pdf", { styleId: "s1", styleName: "EV30068" }),
      doc("b1.pdf", { styleId: "s2", styleName: "EV30021" }),
      doc("b2.pdf", { styleId: "s2", styleName: "EV30021" }),
    ],
    present: [file("a1.pdf"), file("a2.pdf")],
  });
  const zero = ledger.styles.find((s) => s.styleName === "EV30021");
  assert.equal(zero?.delivered, 0);
  assert.equal(zero?.expected, 2);
  assert.equal(ledger.totals.deliveredDocs, 2);
});

test("worst names sort first — missing, then collisions, then renames", () => {
  const ledger = buildDeliveryLedger({
    expected: [
      doc("clean.pdf"),
      doc("gone.pdf"),
      doc("renamed-now.pdf", { storedFileName: "renamed-was.pdf", previousFileName: "renamed-was.pdf" }),
      doc("clash.pdf", { styleId: "s1" }),
      doc("clash.pdf", { styleId: "s2" }),
    ],
    present: [file("clean.pdf"), file("renamed-was.pdf"), file("clash.pdf")],
  });
  assert.deepEqual(
    ledger.names.map((g) => g.fileName),
    ["gone.pdf", "clash.pdf", "renamed-now.pdf", "clean.pdf"],
  );
});

// --- headline + the "is it done" predicate --------------------------------

test("deliveryHeadline leads with the count a human asked for", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("a.pdf"), doc("b.pdf"), doc("c.pdf")],
    present: [file("a.pdf")],
  });
  assert.match(deliveryHeadline(ledger.totals), /^1 of 3 delivered/);
  assert.match(deliveryHeadline(ledger.totals), /2 missing/);
});

test("isFullyDelivered is FALSE while a collision exists, even with nothing missing", () => {
  // The trap: every name is present, so a naive "missing === 0" reads as done
  // while a document has been silently overwritten.
  const ledger = buildDeliveryLedger({
    expected: [doc("x.pdf", { styleId: "s1" }), doc("x.pdf", { styleId: "s2" })],
    present: [file("x.pdf")],
  });
  assert.equal(ledger.totals.missingDocs, 0);
  assert.equal(isFullyDelivered(ledger.totals), false, "a folder that silently drops artwork is not 'delivered'");
});

test("isFullyDelivered is FALSE while anything sits under an old name", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("new.pdf", { storedFileName: "old.pdf", previousFileName: "old.pdf" })],
    present: [file("old.pdf")],
  });
  assert.equal(isFullyDelivered(ledger.totals), false);
});

test("a PO with no expected documents is not 'fully delivered'", () => {
  // Nothing to deliver is not the same as everything delivered; reporting a
  // green tick for an empty PO would hide a style that never generated.
  const ledger = buildDeliveryLedger({ expected: [], present: [] });
  assert.equal(isFullyDelivered(ledger.totals), false);
});

test("matching is case-insensitive and uses the sanitised name the push writes", () => {
  const ledger = buildDeliveryLedger({
    expected: [doc("Wash Care: Label.pdf")],
    present: [file("wash care- label.pdf")],
  });
  assert.equal(ledger.totals.deliveredDocs, 1, "sanitizeFileName rewrites the colon before upload");
});

// --- the cover ------------------------------------------------------------
//
// The cover used to be absent from the expected set entirely: every folder
// audit filtered on reviewStatus === "APPROVED", and the cover is a framing
// manifest that ships while still PENDING_REVIEW. So a PO whose colourways
// overwrote each other's cover reported a clean ledger — which is how a
// supplier received two covers for four styles with nothing noticing.
// isExpectedInSupplierFolder now admits it; these guard the counting once it
// is in.

test("two styles sharing a cover name collide, exactly like any other document", () => {
  const ledger = buildDeliveryLedger({
    expected: [
      doc("00-ab10001-cover-page.pdf", {
        variantKey: "__cover__",
        name: "Cover page",
        styleId: "style-blue",
        styleName: "AB10001",
      }),
      doc("00-ab10001-cover-page.pdf", {
        variantKey: "__cover__",
        name: "Cover page",
        styleId: "style-yellow",
        styleName: "AB10001",
      }),
    ],
    present: [file("00-ab10001-cover-page.pdf")],
  });

  assert.equal(ledger.totals.collisionNames, 1);
  assert.equal(ledger.totals.collisionDocs, 1, "one of the two covers can never land");
  // And it must name the reason a human can act on: two Style ROWS, one number.
  const group = ledger.names.find((g) => g.wanted > 1)!;
  assert.ok(
    group.distinguishers.some((d) => /different styles/i.test(d)),
    `expected a cross-style distinguisher, got: ${group.distinguishers.join("; ")}`,
  );
});

test("covers named per colourway do NOT collide", () => {
  // The other half of the same guard: once the name carries the colourway the
  // ledger must report both covers as ordinary, delivered documents.
  const ledger = buildDeliveryLedger({
    expected: [
      doc("00-ab10001-blue-cover-page.pdf", { variantKey: "__cover__", styleId: "style-blue", styleName: "AB10001" }),
      doc("00-ab10001-yellow-cover-page.pdf", { variantKey: "__cover__", styleId: "style-yellow", styleName: "AB10001" }),
    ],
    present: [file("00-ab10001-blue-cover-page.pdf"), file("00-ab10001-yellow-cover-page.pdf")],
  });

  assert.equal(ledger.totals.collisionDocs, 0);
  assert.equal(ledger.totals.deliveredDocs, 2);
});
