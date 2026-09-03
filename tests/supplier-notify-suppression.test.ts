// A cover refreshed in bulk must reach the supplier's FOLDER without reaching
// their INBOX.
//
// The "Regenerate cover pages" sweep exists to correct covers across the whole
// estate at once — a doc-type rule changed, a manifest line moved. The supplier
// needs the current file; they do not need an email per order about a line that
// changed for reasons internal to us. On 2026-08-13 the same queue, armed in
// bulk by a run of regenerations, mailed 43 suppliers about orders as old as
// PO 61331. `notifySupplier: false` is the valve that stops the sweep being
// that incident again, and it is a SINGLE boolean threaded across two modules
// that never call each other — the one that writes it (enqueueCoverForSupplier)
// and the one that must honour it (runSupplierSendBatch). Nothing about the
// code's shape forces those two to agree, and as of 2026-09-03 the flag has
// never been exercised in production (0 of 2,683 rows carry it), so its first
// real outing will be a bulk one. The contract is pinned here on both sides.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Two suppliers, identical in every respect the batch cares about EXCEPT the
// flag — so the only thing that can separate their fates is notifySupplier.
//   sup-loud    — an ordinary row, armed by a real generation. Must be emailed.
//   sup-quiet   — a cover re-armed by the sweep with notifying off. Must NOT be
//                 emailed, and must NOT be deleted either: the upload sweep
//                 still owes it a push to SharePoint.
const ROWS = [
  {
    id: "q-loud",
    styleId: "sty-loud",
    variantKey: "__cover__",
    docType: "COVER",
    displayName: "Cover page",
    customerId: "cus-1",
    supplierId: "sup-loud",
    poSeq: 70000,
    sentAt: null,
    notifySupplier: true,
  },
  {
    id: "q-quiet",
    styleId: "sty-quiet",
    variantKey: "__cover__",
    docType: "COVER",
    displayName: "Cover page",
    customerId: "cus-1",
    supplierId: "sup-quiet",
    poSeq: 70000,
    sentAt: null,
    notifySupplier: false,
  },
  // Silenced AND below the send cutoff — the row the batch would DESTROY if it
  // filtered notifySupplier late instead of at the query. The cutoff drop is a
  // send-path decision; this row is not on the send path at all, and the upload
  // sweep still owes its file a push. PO 61331 is the age the 2026-08-13 batch
  // reached back to.
  {
    id: "q-quiet-old",
    styleId: "sty-quiet-old",
    variantKey: "__cover__",
    docType: "COVER",
    displayName: "Cover page",
    customerId: "cus-1",
    supplierId: "sup-quiet",
    poSeq: 61331,
    sentAt: null,
    notifySupplier: false,
  },
];

const SUPPLIERS = [
  { id: "sup-loud", name: "Loud Mills", email: "loud@example.test", contactEmail: null },
  { id: "sup-quiet", name: "Quiet Mills", email: "quiet@example.test", contactEmail: null },
];

const STYLES = [
  { id: "sty-loud", name: "Loud Style", poNumber: "70001", businessArea: "BA", supplierFolderUrl: null, businessAreaRef: null },
  { id: "sty-quiet", name: "Quiet Style", poNumber: "70002", businessArea: "BA", supplierFolderUrl: null, businessAreaRef: null },
];

type Dispatch = { to: string; cc?: string[]; subject: string; html: string; text: string };
let dispatches: Dispatch[] = [];
let deletedIds: string[] = [];
// Every upsert enqueueCoverForSupplier performs, so both halves can be read.
let upserts: Array<{ where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }> = [];

// The style enqueueCoverForSupplier resolves. Mutable so one test can flip the
// customer config / supplier without rebuilding the whole mock.
let enqueueStyle: unknown = {
  customerId: "cus-1",
  supplierId: "sup-quiet",
  poSeq: 70000,
  customer: { config: {} },
};

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        supplierSendQueueItem: {
          // Honours the `where` it is given rather than returning the fixture
          // wholesale. This is the point of the test: if a refactor drops
          // `notifySupplier: true` from the query, the quiet row flows through
          // here and the assertions below fail — which is exactly what a real
          // database would do.
          findMany: async (args: { where: Record<string, unknown> }) =>
            ROWS.filter((r) => {
              const w = args.where ?? {};
              if ("sentAt" in w && r.sentAt !== w.sentAt) return false;
              if ("notifySupplier" in w && r.notifySupplier !== w.notifySupplier) return false;
              return true;
            }),
          deleteMany: async (args: { where: { id: { in: string[] } } }) => {
            deletedIds.push(...args.where.id.in);
            return { count: args.where.id.in.length };
          },
          updateMany: async () => ({ count: 0 }),
          upsert: async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
            upserts.push(args);
            return {};
          },
        },
        supplierSendBatch: {
          create: async () => ({ id: "batch-1" }),
          update: async () => ({}),
        },
        style: {
          findMany: async (args: { where: { id: { in: string[] } } }) =>
            STYLES.filter((s) => args.where.id.in.includes(s.id)),
          findUnique: async () => enqueueStyle,
        },
        supplier: {
          findMany: async (args: { where: { id: { in: string[] } } }) =>
            SUPPLIERS.filter((s) => args.where.id.in.includes(s.id)),
        },
        customer: {
          findMany: async () => [{ id: "cus-1", config: {} }],
        },
        supplierShare: { findMany: async () => [] },
        // enqueueCoverForSupplier counts real (non-framing) outputs before it
        // will arm a cover at all.
        jobAsset: { count: async () => 3 },
      },
    },
  });

  mock.module("@/lib/settings/app-settings", {
    namedExports: {
      getSupplierBatchSendEnabled: async () => true,
      // Below both fixtures' poSeq, so the cutoff never explains a missing mail.
      getSupplierSendMinPo: async () => 63320,
    },
  });

  mock.module("@/lib/email/dispatch", {
    namedExports: {
      dispatchEmail: async (msg: Dispatch) => {
        dispatches.push(msg);
        return { status: "SENT", emailLogId: "log-1", note: null };
      },
    },
  });

  mock.module("@/lib/outputs/output-ignores", {
    namedExports: { loadIgnoredOutputKeysByStyle: async () => new Map() },
  });
  mock.module("@/lib/suppliers/contact-emails", {
    namedExports: { loadContactEmailsBySupplier: async () => new Map() },
  });
  mock.module("@/lib/sharepoint/push-queued-to-supplier", {
    namedExports: {
      pushQueuedSupplierUploads: async () => ({ styles: 0, uploaded: 0, failed: 0, skipped: 0, noFolder: 0, ambiguous: 0, failures: [] }),
    },
  });
});

beforeEach(() => {
  dispatches = [];
  deletedIds = [];
  upserts = [];
  enqueueStyle = {
    customerId: "cus-1",
    supplierId: "sup-quiet",
    poSeq: 70000,
    customer: { config: {} },
  };
});

test("the nightly digest never emails a notifySupplier:false row", async () => {
  const { runSupplierSendBatch } = await import("@/lib/publish/supplier-batch-send");
  const result = await runSupplierSendBatch({ source: "midnight" });

  const recipients = dispatches.flatMap((d) => [d.to, ...(d.cc ?? [])]);
  assert.ok(
    !recipients.includes("quiet@example.test"),
    `a silenced row reached a supplier inbox: ${recipients.join(", ")}`,
  );
  // …and the loud row still went, so the test can fail for the right reason —
  // a batch that emails nobody would satisfy the assertion above by accident.
  assert.deepEqual(recipients, ["loud@example.test"]);
  assert.equal(result.supplierCount, 1);
  assert.equal(result.outputCount, 1);
});

test("a silenced row below the cutoff is not deleted by the batch", async () => {
  // Silenced rows are excluded from `pending` at the QUERY, so none of the
  // batch's deleteMany guards can reach them. The below-cutoff row is the proof
  // that matters: filter notifySupplier late instead and the cutoff sweep
  // deletes it on the way past — discarding a row the upload sweep still owes
  // SharePoint a push for, with nothing left to retry.
  const { runSupplierSendBatch } = await import("@/lib/publish/supplier-batch-send");
  await runSupplierSendBatch({ source: "midnight" });

  assert.ok(!deletedIds.includes("q-quiet-old"), "the silenced below-cutoff row was deleted");
  assert.ok(!deletedIds.includes("q-quiet"), "the silenced queue row was deleted");
});

test("enqueueCoverForSupplier({notifySupplier:false}) silences BOTH upsert halves", async () => {
  const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");
  const outcome = await enqueueCoverForSupplier("sty-quiet", "asset-1", { notifySupplier: false });

  assert.equal(outcome, "queued");
  assert.equal(upserts.length, 1);
  // The UPDATE half is the one that matters: a row already armed to notify by
  // an earlier generation must be silenced when the sweep re-arms it, not left
  // shouting. A create-only default would sail past a create-path assertion.
  assert.equal(upserts[0].update.notifySupplier, false);
  assert.equal(upserts[0].create.notifySupplier, false);
});

test("an ordinary re-arm still notifies — silence is opt-in, never the default", async () => {
  // The runner and every ordinary caller pass no options at all. If silence
  // ever became the default, covers would stop being announced estate-wide and
  // nothing would say so.
  const { enqueueCoverForSupplier } = await import("@/lib/publish/requeue-cover");
  await enqueueCoverForSupplier("sty-quiet", "asset-1");

  assert.equal(upserts[0].update.notifySupplier, true);
  assert.equal(upserts[0].create.notifySupplier, true);
});
