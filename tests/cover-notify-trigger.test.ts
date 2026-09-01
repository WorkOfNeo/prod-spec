// A cover rebuild always re-uploads. Whether it also EMAILS is decided by why
// the rebuild happened — and that decision must never stick to the queue row.
//
// The trap this pins: SupplierUploadQueue.notifySupplier is a column, so it is
// tempting to read the false a wording sweep wrote as "this style has opted out
// of digests". It has not. A wording sweep now runs across the whole book (the
// packaging wording joined the manifest fingerprint), so if false latched, one
// quiet sweep would mute every cover in the estate permanently — and the next
// genuinely new document for those styles would reach the supplier's folder
// with nobody ever told.
//
// So the sequence asserted below is the whole point: silence, then a real
// generation, and the row is armed to notify again.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const STYLE_ID = "s1";

// The persisted queue row, as the DB would hold it between calls. `null` until
// something upserts it — the shape the very first arm sees.
let row: Record<string, unknown> | null = null;
let upsertCalls = 0;

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        style: {
          findUnique: async () => ({
            customerId: "c1",
            supplierId: "sup1",
            poSeq: 70000,
            // No self-delivery flag — an ordinary customer we ship to.
            customer: { config: null },
          }),
        },
        // ≥1 real generated output, so the cover is allowed to ship at all.
        jobAsset: { count: async () => 3 },
        supplierSendQueueItem: {
          upsert: async (args: {
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            upsertCalls += 1;
            row = row === null ? { ...args.create } : { ...row, ...args.update };
            return row;
          },
        },
      },
    },
  });

  // No supplier-send cutoff configured, so the PO gate is a pass-through and
  // this test is about the notify flag and nothing else.
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getSupplierSendMinPo: async () => null },
  });

  // The sweep's other collaborators. The cover always "refreshes" — the render
  // is not what is under test; what the refresh then ARMS is.
  mock.module("@/lib/pdf/refresh-cover", {
    namedExports: {
      refreshStyleCoverAsset: async (styleId: string) => ({
        styleId,
        status: "refreshed",
        coverAssetId: "cover-asset-1",
        jobId: "job-1",
      }),
    },
  });
  mock.module("@/lib/outputs/required-packaging", {
    namedExports: { loadTrimSettings: async () => ({}) },
  });
  mock.module("@/lib/sharepoint/push-queued-to-supplier", {
    namedExports: { pushQueuedSupplierUploads: async () => ({ uploaded: 1, failed: 0 }) },
  });
});

beforeEach(() => {
  row = null;
  upsertCalls = 0;
});

test("a wording sweep delivers the cover but arms the row silent", async () => {
  const { processCoverRefreshChunk } = await import("@/lib/pdf/cover-regen-sweep");

  const result = await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "wording" });

  assert.equal(result.outcomes[0]?.requeue, "queued", "the file still goes to the supplier");
  assert.equal(row?.notifySupplier, false, "…but the row is kept out of tonight's digest");
  // Delivered, not merely queued: the row must be armed for the SharePoint push.
  assert.equal(row?.sharePointStatus, "PENDING");
  assert.equal(row?.sentAt, null);
});

test("a content rebuild notifies, exactly as it always has", async () => {
  const { processCoverRefreshChunk } = await import("@/lib/pdf/cover-regen-sweep");

  await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "content" });

  assert.equal(row?.notifySupplier, true);
});

test("silenced by a wording sweep, then genuinely regenerated → notifies again", async () => {
  const { processCoverRefreshChunk } = await import("@/lib/pdf/cover-regen-sweep");
  const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");

  // 1. The wording edit sweeps the book and silences this style's row.
  await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "wording" });
  assert.equal(row?.notifySupplier, false);

  // 2. …and again, because a sweep is re-runnable and an operator may run two
  //    wording edits back to back. Still silent, still not latched.
  await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "wording" });
  assert.equal(row?.notifySupplier, false);

  // 3. Now the style is genuinely regenerated — the runner's call shape, which
  //    passes no opts at all. THE ROW MUST GO BACK TO NOTIFYING. If this ever
  //    reads false, a supplier is receiving new documents in silence.
  await enqueueCoverForSupplier(STYLE_ID, "cover-asset-2");

  assert.equal(row?.notifySupplier, true, "a real generation re-arms notification");
  assert.equal(row?.jobAssetId, "cover-asset-2", "…pointing at the newly rendered cover");
  assert.equal(upsertCalls, 3);
});

test("the order does not matter — a wording sweep after a content rebuild re-silences", async () => {
  const { processCoverRefreshChunk } = await import("@/lib/pdf/cover-regen-sweep");

  await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "content" });
  assert.equal(row?.notifySupplier, true);

  // The reverse direction has to hold too, or a style that was ever approved
  // would be permanently un-silenceable and every wording sweep would mail it.
  await processCoverRefreshChunk([STYLE_ID], { deliver: true, trigger: "wording" });
  assert.equal(row?.notifySupplier, false);
});
