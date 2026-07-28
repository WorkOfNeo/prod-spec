// Self-heal verify test for verifySupplierUploads (WS4). Drives the REAL
// function with the DB and SharePoint Graph layer stubbed, proving the three
// branches that make it safe:
//
//   • file present in the folder      → row stamped verified, NOT re-armed.
//   • folder resolves, file missing   → row auto re-armed to PENDING (self-heal).
//   • folder can't be resolved (403 / → row LEFT UNTOUCHED. This is the critical
//     transient / no supplier link)     safety property: a permission or network
//                                        blip must never be read as "missing" and
//                                        wipe a real UPLOADED status.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mutable state the mocks read at call time ───────────────────────────────
type Scenario = "present" | "file-missing" | "po-missing" | "ambiguous" | "unresolved";
let scenario: Scenario = "present";
let folderNames = new Set<string>();
let updateCalls: Array<{ where: { id: { in: string[] } }; data: Record<string, unknown> }> = [];

const UPLOADED_ROW = { id: "q1", styleId: "s1", variantKey: "base1", jobAssetId: "a1" };
const STYLE_ROW = {
  id: "s1",
  name: "STY",
  poNumber: "C-PO1",
  customer: { name: "Cust" },
  supplier: { name: "Sup", sharepointUrl: "https://share/sup" },
};
// The push wrote this exact file name; the folder listing is matched against it.
const FILE_NAME = "STY-care-label.pdf";

before(() => {
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getSupplierBatchSendEnabled: async () => true },
  });

  mock.module("@/lib/db", {
    namedExports: {
      db: {
        supplierSendQueueItem: {
          findMany: async () => [UPLOADED_ROW],
          updateMany: async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
            updateCalls.push(args);
            return { count: args.where.id.in.length };
          },
        },
        style: { findMany: async () => [STYLE_ROW] },
        jobAsset: { findMany: async () => [{ id: "a1", fileName: FILE_NAME }] },
      },
    },
  });

  // Current-outputs walk — the approved slot resolves to exactly the file the
  // push wrote (mirrors production; verify looks for these names in the folder).
  mock.module("@/lib/outputs/current-outputs", {
    namedExports: {
      getCurrentOutputsForStyle: async () => [
        {
          variantKey: "base1",
          docType: "CARE_LABEL",
          fileName: FILE_NAME,
          jobAssetId: "a1",
          reviewStatus: "APPROVED",
          placeholderCount: 0,
        },
      ],
    },
  });

  // SharePoint Graph layer. sanitizeName is included because
  // supplier-folder-names.ts imports it transitively from this same module.
  // resolvePoFolder is stubbed per-scenario so the verify branch under test is
  // isolated from the matcher (which has its own pure test).
  mock.module("@/lib/sharepoint/supplier-folder", {
    namedExports: {
      sanitizeName: (s: string) => s,
      // mock.module replaces the module WHOLESALE, so every named export the
      // subject imports has to be stubbed here. verify-supplier-uploads has
      // imported sanitizeFileName since the expected-name comparison landed;
      // without this the suite failed with "sanitizeFileName is not a
      // function" — a mock gap, never a fault in the code under test.
      sanitizeFileName: (s: string) => s,
      resolveSupplierFolder: async () => {
        if (scenario === "unresolved") throw new Error("share link would not resolve");
        return { driveId: "d", itemId: "root", webUrl: null };
      },
      listChildFolders: async () => [],
      resolvePoFolder: () => {
        if (scenario === "po-missing") return { status: "missing" };
        if (scenario === "ambiguous")
          return { status: "ambiguous", matches: [{ id: "a", name: "C-PO1 x" }, { id: "b", name: "C-PO1 y" }] };
        return { status: "found", folder: { id: "po", name: "C-PO1 - Cust - Sup", webUrl: "https://po", childCount: 1 } };
      },
      findChildFolder: async () => ({ id: "leaf", webUrl: "https://leaf", childCount: 1 }),
      listChildFileNames: async () => folderNames,
    },
  });
});

beforeEach(() => {
  updateCalls = [];
});

test("file present → row verified, never re-armed", async () => {
  scenario = "present";
  folderNames = new Set([FILE_NAME.toLowerCase()]);
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.verified, 1);
  assert.equal(sweep.healed, 0);
  assert.equal(sweep.unresolved, 0);
  assert.equal(updateCalls.length, 1);
  // Stamped verified; NOT flipped back to PENDING.
  assert.ok(updateCalls[0].data.sharePointVerifiedAt instanceof Date);
  assert.equal(updateCalls[0].data.sharePointStatus, undefined);
});

test("PO folder found but file missing from APPROVED LAYOUTS → row auto re-armed", async () => {
  scenario = "file-missing";
  folderNames = new Set();
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.healed, 1);
  assert.equal(sweep.verified, 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.sharePointStatus, "PENDING");
  assert.equal(updateCalls[0].data.pushAttempts, 0);
  assert.equal(updateCalls[0].data.sharePointVerifiedAt, null);
});

test("PO folder no longer exists → row auto re-armed (next push flags NO_FOLDER)", async () => {
  scenario = "po-missing";
  folderNames = new Set();
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.healed, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].data.sharePointStatus, "PENDING");
});

test("PO folder ambiguous → row LEFT UNTOUCHED (can't conclude 'missing')", async () => {
  scenario = "ambiguous";
  folderNames = new Set();
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.unresolved, 1);
  assert.equal(sweep.healed, 0);
  assert.equal(sweep.verified, 0);
  assert.equal(updateCalls.length, 0);
});

test("folder unresolvable (403/transient) → row LEFT UNTOUCHED", async () => {
  scenario = "unresolved";
  folderNames = new Set();
  const { verifySupplierUploads } = await import("@/lib/sharepoint/verify-supplier-uploads");

  const sweep = await verifySupplierUploads();

  assert.equal(sweep.unresolved, 1);
  assert.equal(sweep.verified, 0);
  assert.equal(sweep.healed, 0);
  // The critical safety property: no write at all — the UPLOADED status stands.
  assert.equal(updateCalls.length, 0);
});
