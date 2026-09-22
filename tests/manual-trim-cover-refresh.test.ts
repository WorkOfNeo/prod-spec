// The cover hand-off behind "Manually supplied packaging" — what happens to the
// supplier's cover PDF after a manual line is supplied, approved by hand,
// withdrawn or removed.
//
// This module exists because of a real leak: for one release every one of those
// mutations updated the manifest in the database and left the supplier holding
// a cover that still said "Waiting for Customer Information". The rebuild was
// in principle handled by the Settings ▸ Cover page sweep — which has no cron
// behind it, so in practice by nothing.
//
// Three properties are pinned here, and they pull in opposite directions:
//
//   1. IT REBUILDS AND RE-PUSHES when the manifest genuinely moved.
//   2. IT DOES NOTHING when it didn't. This one guards a supplier's folder: a
//      rebuild overwrites their cover and re-arms a digest row, so doing it for
//      a page that would print identically is a cost with no benefit. The gate
//      is onlyWhenChanged, and that it is REQUESTED is asserted directly.
//   3. IT NEVER THROWS. By the time it runs the operator's action is committed;
//      a throw would surface as a 500 and tell someone their approval failed
//      when it did not.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const STYLE_ID = "style-1";

type RefreshOpts = { onlyWhenChanged?: boolean; onlyWhenPending?: boolean; stampManifest?: boolean };
let lastRefreshOpts: RefreshOpts | null = null;
const refreshStyleCoverAsset = mock.fn(async (_styleId: string, opts?: RefreshOpts) => {
  lastRefreshOpts = opts ?? null;
  return { styleId: STYLE_ID, status: "refreshed", coverAssetId: "cover-1", jobId: "job-1" } as unknown;
});

type EnqueueOpts = { notifySupplier?: boolean };
let lastEnqueue: { styleId: string; assetId: string; opts?: EnqueueOpts } | null = null;
const enqueueCoverForSupplier = mock.fn(
  async (styleId: string, assetId: string, opts?: EnqueueOpts) => {
    lastEnqueue = { styleId, assetId, opts };
    return "queued" as unknown;
  },
);

let lastPush: { styleIds?: string[]; recordRunAs?: string } | null = null;
const pushQueuedSupplierUploads = mock.fn(
  async (args: { styleIds?: string[]; recordRunAs?: string }) => {
    lastPush = args;
    return { uploaded: 1, failed: 0, skipped: 0, styles: 1, noFolder: 0, ambiguous: 0, failures: [] };
  },
);

before(() => {
  mock.module("@/lib/pdf/refresh-cover", { namedExports: { refreshStyleCoverAsset } });
  mock.module("@/lib/publish/requeue-cover", { namedExports: { enqueueCoverForSupplier } });
  mock.module("@/lib/sharepoint/push-queued-to-supplier", {
    namedExports: { pushQueuedSupplierUploads },
  });
  // The trigger rule is a pure leaf and stays REAL — "does the supplier hear
  // about this?" is one of the things under test, not a stub.
});

beforeEach(() => {
  refreshStyleCoverAsset.mock.resetCalls();
  enqueueCoverForSupplier.mock.resetCalls();
  pushQueuedSupplierUploads.mock.resetCalls();
  lastRefreshOpts = null;
  lastEnqueue = null;
  lastPush = null;
});

async function run() {
  const mod = await import("@/lib/trims/manual-trim-cover-refresh");
  return mod.refreshCoverAfterManualTrimChangeSafe(STYLE_ID);
}

// ── 1. The happy path: the loop is actually closed ──────────────────────────

test("a moved manifest rebuilds the cover, re-arms the row and pushes it", async () => {
  const out = await run();
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 1);
  assert.equal(enqueueCoverForSupplier.mock.callCount(), 1);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 1);
  assert.equal(out.cover, "refreshed");
  assert.equal(out.pushed, 1);
  assert.match(out.message ?? "", /supplier/i, "the reviewer is told the folder was corrected");
});

test("the push is scoped to this one style and recorded as its own run", async () => {
  await run();
  assert.deepEqual(lastPush?.styleIds, [STYLE_ID], "nothing else in the queue rides along");
  assert.equal(lastPush?.recordRunAs, "manual-trim", "the /automation row names what caused it");
});

test("the supplier IS told — this is content, not a wording sweep", async () => {
  await run();
  assert.equal(
    lastEnqueue?.opts?.notifySupplier,
    true,
    "a line they were asked to wait for is now supplied: this order's own facts moved",
  );
  assert.equal(lastEnqueue?.styleId, STYLE_ID);
  assert.equal(lastEnqueue?.assetId, "cover-1", "the asset the refresh actually rebuilt");
});

// ── 2. The guard on a supplier's folder ─────────────────────────────────────

test("it asks for onlyWhenChanged — never an unconditional rebuild", async () => {
  await run();
  assert.equal(
    lastRefreshOpts?.onlyWhenChanged,
    true,
    "without this gate, replacing a file on an already-delivered line would overwrite a supplier's cover to change nothing",
  );
});

test("an unchanged manifest pushes nothing and says nothing", async () => {
  refreshStyleCoverAsset.mock.mockImplementationOnce(
    async () => ({ styleId: STYLE_ID, status: "skipped-unchanged" }) as unknown,
  );
  const out = await run();
  assert.equal(out.cover, "unchanged");
  assert.equal(enqueueCoverForSupplier.mock.callCount(), 0, "no digest row re-armed");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0, "no file overwritten");
  assert.equal(out.message, null, "and nothing claimed to the reviewer");
});

test("a style with no cover yet is reported, not treated as a failure", async () => {
  refreshStyleCoverAsset.mock.mockImplementationOnce(
    async () => ({ styleId: STYLE_ID, status: "no-cover" }) as unknown,
  );
  const out = await run();
  assert.equal(out.cover, "no-cover");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0);
  assert.match(out.message ?? "", /first one/i);
});

test("a blocked enqueue gate is explained, and nothing is pushed", async () => {
  enqueueCoverForSupplier.mock.mockImplementationOnce(async () => "below-cutoff" as unknown);
  const out = await run();
  assert.equal(out.cover, "refreshed", "the app's own copy IS corrected");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0);
  assert.match(out.message ?? "", /cutoff/, "half-successes are never left silent");
});

test("batch-send off is reported as queued, not as success or failure", async () => {
  pushQueuedSupplierUploads.mock.mockImplementationOnce(async () => ({
    uploaded: 0,
    failed: 0,
    skipped: 0,
    styles: 0,
    noFolder: 0,
    ambiguous: 0,
    failures: [],
  }));
  const out = await run();
  assert.equal(out.pushed, 0);
  assert.match(out.message ?? "", /queued|off/i);
});

// ── 3. It can never undo the action that called it ──────────────────────────

test("a refresh that throws comes back as an outcome, not an exception", async () => {
  refreshStyleCoverAsset.mock.mockImplementationOnce(async () => {
    throw new Error("puppeteer died");
  });
  const out = await run();
  assert.equal(out.cover, "error");
  assert.match(out.message ?? "", /couldn't be rebuilt/);
  assert.match(out.message ?? "", /puppeteer died/, "the real reason survives to the panel");
});

test("an enqueue that throws still leaves the rebuilt cover reported", async () => {
  enqueueCoverForSupplier.mock.mockImplementationOnce(async () => {
    throw new Error("queue exploded");
  });
  const out = await run();
  assert.equal(out.cover, "refreshed");
  assert.equal(out.requeue, "error");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0);
});

test("a push that throws still leaves the rebuilt cover reported", async () => {
  pushQueuedSupplierUploads.mock.mockImplementationOnce(async () => {
    throw new Error("Graph is down");
  });
  const out = await run();
  assert.equal(out.cover, "refreshed");
  assert.equal(out.pushed, 0);
  assert.match(out.message ?? "", /Graph is down/);
});
