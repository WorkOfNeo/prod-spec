// File-name COLLISION behaviour in the self-heal verify.
//
// The bug this pins: a split output whose documents all resolve to the same
// file name uploads N PDFs to one name, SharePoint keeps the last, and the slot
// is permanently short — while the row is honestly "UPLOADED" and verify's
// Set-membership check is honestly satisfied by the one surviving file. The
// style reads "all delivered" forever.
//
// Two properties are asserted, and the second matters as much as the first:
//
//   1. the loss is COUNTED (sweep.collided), so it can be surfaced; and
//   2. the row is still VERIFIED, never re-armed. Re-arming would re-upload the
//      same colliding names, land the same single file, and re-arm again on
//      every sweep — an infinite churn against Graph that never converges.
//      A collision is fixed by editing the file-name template, not by retrying.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

let folderNames = new Set<string>();
let updateCalls: Array<{ where: { id: { in: string[] } }; data: Record<string, unknown> }> = [];

const ROW = { id: "q1", styleId: "s1", variantKey: "layout:L1", jobAssetId: "a1" };
const STYLE_ROW = {
  id: "s1",
  name: "STY",
  poNumber: "C-PO1",
  supplierPoFolderName: null,
  customer: { name: "Cust" },
  supplier: { name: "Sup", sharepointUrl: "https://share/sup" },
};

// One slot, three split documents — all resolving to ONE name. This is the
// real-world shape: a carton-marking template whose {{size}} resolves empty for
// that doc type, so every split row produces the identical name.
const COLLIDING_NAME = "STY-carton-marking.pdf";
const DOCS = ["4-5R-Mix", "6-7R-Mix", "8R-Mix"].map((suffix, i) => ({
  variantKey: `layout:L1#${suffix}`,
  docType: "CARTON_MARKING",
  fileName: COLLIDING_NAME,
  jobAssetId: `a${i + 1}`,
  reviewStatus: "APPROVED",
  placeholderCount: 0,
}));

let currentDocs: typeof DOCS = DOCS;

before(() => {
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getSupplierBatchSendEnabled: async () => true },
  });

  mock.module("@/lib/db", {
    namedExports: {
      db: {
        supplierSendQueueItem: {
          findMany: async () => [ROW],
          updateMany: async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
            updateCalls.push(args);
            return { count: args.where.id.in.length };
          },
        },
        style: { findMany: async () => [STYLE_ROW] },
        jobAsset: { findMany: async () => [{ id: "a1", fileName: COLLIDING_NAME }] },
      },
    },
  });

  // Read at call time — a module can only be mocked once per process, so the
  // per-test fixture has to be mutable state rather than a second mock.module.
  mock.module("@/lib/outputs/current-outputs", {
    namedExports: { getCurrentOutputsForStyle: async () => currentDocs },
  });

  mock.module("@/lib/sharepoint/supplier-folder", {
    namedExports: {
      sanitizeName: (s: string) => s,
      sanitizeFileName: (s: string) => s,
      resolveSupplierFolder: async () => ({ driveId: "d", itemId: "root", webUrl: null }),
      listChildFolders: async () => [],
      resolvePoFolder: () => ({
        status: "found",
        folder: { id: "po", name: "C-PO1 - Cust - Sup", webUrl: "https://po", childCount: 1 },
      }),
      findChildFolder: async () => ({ id: "leaf", webUrl: "https://leaf", childCount: 1 }),
      listChildFileNames: async () => folderNames,
    },
  });
});

beforeEach(() => {
  updateCalls = [];
  currentDocs = DOCS;
});

test("3 documents sharing one file name → 2 counted as lost, row still verified (no churn)", async () => {
  // The one surviving file is in the folder — exactly what production looks
  // like after three PUTs to the same name.
  folderNames = new Set([COLLIDING_NAME.toLowerCase()]);
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  // The shortfall is now visible instead of silent.
  assert.equal(sweep.collided, 2, "3 documents − 1 distinct name = 2 permanently lost");
  assert.equal(sweep.verified, 1);
  // The critical anti-churn property: NOT re-armed.
  assert.equal(sweep.healed, 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.sharePointStatus, undefined, "must not flip back to PENDING");
  assert.ok(updateCalls[0].data.sharePointVerifiedAt instanceof Date);
});

test("colliding documents whose single name is absent → still heals (converges, then reports)", async () => {
  // Nothing landed at all: the collision must not mask a genuine missing file,
  // or a slot that never uploaded would be written off as "just a collision".
  folderNames = new Set();
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.healed, 1, "absent file is re-armed even when the names collide");
  assert.equal(sweep.verified, 0);
  // Not counted as collided: the loss reported is only the one we can prove,
  // and here the push hasn't had its chance yet.
  assert.equal(sweep.collided, 0);
  assert.equal(updateCalls[0].data.sharePointStatus, "PENDING");
});

test("distinct names all present → no collision reported", async () => {
  // Control: the same slot with a template that DOES vary must stay clean, so
  // the counter can't drift into false positives on healthy styles.
  currentDocs = DOCS.map((d, i) => ({ ...d, fileName: `STY-carton-marking-${i}.pdf` }));
  folderNames = new Set(["sty-carton-marking-0.pdf", "sty-carton-marking-1.pdf", "sty-carton-marking-2.pdf"]);
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.collided, 0);
  assert.equal(sweep.verified, 1);
  assert.equal(sweep.healed, 0);
});
