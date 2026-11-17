// Ignoring an output for a style — or undoing that — must schedule the cover
// rebuild.
//
//   POST   /api/admin/job-assets/[id]/ignore
//   DELETE /api/admin/styles/[id]/output-ignores?variantKey=<base>
//
// WHY. The cover lists every output the style still needs. An Ignore takes one
// off that list, an undo puts it back — but the cover is a stored PDF, and
// nothing rebuilt it: the job can't settle while its own cover asset is
// pending, and a re-run of a style whose other outputs were approved ended
// before the cover step. Field case 2026-11-17: a socks style's cover kept a
// "Wash Care Label · Waiting for Customer Information" row through three
// re-runs after a reviewer ignored that label. Both routes now stamp the style
// into the SHARED debounced cover-regen ledger, the same one approve/reject use.
//
// Drives the REAL handlers with a mocked session and spy db — no live DB.
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
const asReviewer = () => {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
};
const asViewer = () => {
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
};

const STYLE_ID = "style-1";
const BASE_KEY = "layout:washcare";

let assetRow: unknown = null;
const jobAssetFindUnique = mock.fn(async () => assetRow);
const ignoreUpsert = mock.fn(async () => ({}));
let removedCount = 1;
const ignoreDeleteMany = mock.fn(async () => ({ count: removedCount }));
const scheduleCoverRegen = mock.fn<(styleId: string) => Promise<void>>(async () => {});
const maybeSettleJob = mock.fn(async () => ({ ok: true, settled: false }));

before(() => {
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        jobAsset: { findUnique: jobAssetFindUnique },
        styleOutputIgnore: { upsert: ignoreUpsert, deleteMany: ignoreDeleteMany },
        supplierSendQueueItem: { deleteMany: mock.fn(async () => ({ count: 0 })) },
        log: { create: mock.fn(async () => ({})) },
      },
    },
  });
  mock.module("@/lib/review-flow/claim", {
    namedExports: { claimReviewIfUnclaimed: async () => {} },
  });
  mock.module("@/lib/tickets/rejection-tickets", {
    namedExports: { resolveRejectionTicketsFor: async () => 0 },
  });
  mock.module("@/lib/publish/settle-job", { namedExports: { maybeSettleJob } });
  mock.module("@/lib/pdf/cover-regen-schedule", { namedExports: { scheduleCoverRegen } });
});

beforeEach(() => {
  asReviewer();
  removedCount = 1;
  assetRow = {
    id: "asset-1",
    jobId: "job-1",
    variantKey: `${BASE_KEY}#3538-MIX`,
    docType: "WASHCARE",
    displayName: "Wash Care Label · 3538-MIX",
    job: { styleId: STYLE_ID },
  };
  for (const f of [jobAssetFindUnique, ignoreUpsert, ignoreDeleteMany, scheduleCoverRegen, maybeSettleJob]) {
    f.mock.resetCalls();
  }
});

async function ignore() {
  const { POST } = await import("@/app/api/admin/job-assets/[id]/ignore/route");
  return POST(new NextRequest("http://localhost/api/admin/job-assets/asset-1/ignore", { method: "POST" }), {
    params: Promise.resolve({ id: "asset-1" }),
  });
}

async function unignore() {
  const { DELETE } = await import("@/app/api/admin/styles/[id]/output-ignores/route");
  return DELETE(
    new NextRequest(
      `http://localhost/api/admin/styles/${STYLE_ID}/output-ignores?variantKey=${encodeURIComponent(BASE_KEY)}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: STYLE_ID }) },
  );
}

test("ignoring an output schedules the style's cover rebuild", async () => {
  const res = await ignore();
  assert.equal(res.status, 200);
  assert.equal(ignoreUpsert.mock.callCount(), 1);
  assert.deepEqual(
    scheduleCoverRegen.mock.calls.map((c) => c.arguments[0]),
    [STYLE_ID],
  );
});

test("the rebuild is scheduled before the job settles", async () => {
  // Settling can publish (SharePoint upload, slow); the cover demand must be
  // on the ledger whatever happens there.
  const order: string[] = [];
  scheduleCoverRegen.mock.mockImplementationOnce(async () => {
    order.push("cover");
  });
  maybeSettleJob.mock.mockImplementationOnce(async () => {
    order.push("settle");
    return { ok: true, settled: false };
  });
  await ignore();
  assert.deepEqual(order, ["cover", "settle"]);
});

test("a refused ignore schedules nothing", async () => {
  asViewer();
  assert.equal((await ignore()).status, 403);

  asReviewer();
  assetRow = { ...(assetRow as object), variantKey: "__cover__", docType: "COVER" };
  assert.equal((await ignore()).status, 400);

  assert.equal(scheduleCoverRegen.mock.callCount(), 0);
});

test("undoing an ignore schedules the style's cover rebuild", async () => {
  const res = await unignore();
  assert.equal(res.status, 200);
  assert.deepEqual(
    scheduleCoverRegen.mock.calls.map((c) => c.arguments[0]),
    [STYLE_ID],
  );
});

test("an undo that removed nothing schedules nothing", async () => {
  removedCount = 0;
  const res = await unignore();
  assert.equal(res.status, 200);
  assert.equal(scheduleCoverRegen.mock.callCount(), 0);
});
