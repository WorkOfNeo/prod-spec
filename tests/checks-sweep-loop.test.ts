// The all-PO sweep's loop, with the database and the folder check both faked.
// What is being pinned down here is the behaviour that only shows up over 370
// folders and an hour of wall clock — and that therefore cannot be seen on the
// per-PO page:
//
//   • it resumes: a run that lost its process picks up the folders it never
//     reached, and never re-checks the ones it did;
//   • it does not fan out: exactly one purchase order is in flight at a time;
//   • it stops rather than recording an outage as a result;
//   • it backs off when SharePoint says to, instead of pushing harder;
//   • it never repairs anything, and offers no route into the apply.
//
// Requires Node's module-mock API:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── An in-memory stand-in for the two sweep tables ──────────────────────────
type Row = Record<string, unknown>;
let sweeps: Row[] = [];
let pos: Row[] = [];
let ids = 0;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v instanceof Date) return (row[k] as Date)?.getTime?.() === v.getTime();
    if (v && typeof v === "object" && "notIn" in (v as Row)) {
      return !(((v as Row).notIn as unknown[]) ?? []).includes(row[k]);
    }
    if (v && typeof v === "object" && "gt" in (v as Row)) return (row[k] as number) > ((v as Row).gt as number);
    return row[k] === v;
  });

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as Row).increment as number);
    } else row[k] = v;
  }
  return row;
}

const db = {
  folderCheckSweep: {
    findFirst: async ({ where }: { where?: Row } = {}) =>
      [...sweeps].reverse().find((s) => matches(s, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => sweeps.find((s) => s.id === where.id) ?? null,
    create: async ({ data }: { data: Row }) => {
      const s: Row = {
        id: `sweep-${++ids}`,
        status: "RUNNING",
        heartbeatAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        checkedPos: 0,
        unreadablePos: 0,
        erroredPos: 0,
        posWithFindings: 0,
        flaggedFiles: 0,
        error: null,
        ...data,
      };
      sweeps.push(s);
      return s;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const s = sweeps.find((r) => r.id === where.id)!;
      return applyData(s, data);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = sweeps.filter((s) => matches(s, where));
      hit.forEach((s) => applyData(s, data));
      return { count: hit.length };
    },
  },
  folderCheckSweepPo: {
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) {
        pos.push({
          id: `po-${++ids}`,
          state: "pending",
          flaggedFiles: 0,
          scannedFiles: 0,
          styleCount: 0,
          findings: null,
          notes: null,
          checkedAt: null,
          error: null,
          ...d,
        });
      }
      return { count: data.length };
    },
    findFirst: async ({ where }: { where: Row }) =>
      pos
        .filter((p) => matches(p, where))
        .sort((a, b) => ((b.poSeq as number) ?? 0) - ((a.poSeq as number) ?? 0))[0] ?? null,
    findMany: async ({ where }: { where: Row }) => pos.filter((p) => matches(p, where)),
    count: async ({ where }: { where: Row }) => pos.filter((p) => matches(p, where)).length,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const p = pos.find((r) => r.id === where.id)!;
      return applyData(p, data);
    },
  },
  $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
};

// ── The folder check, faked ────────────────────────────────────────────────
let inFlight = 0;
let maxInFlight = 0;
let reportFor: (po: string) => Record<string, unknown>;

const runPoChecks = mock.fn(async ({ poNumber }: { poNumber: string }) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 1));
  inFlight -= 1;
  const r = reportFor(poNumber);
  if (r instanceof Error) throw r;
  return r;
});

function report(state: string, flagged: Array<Record<string, unknown>> = []) {
  return {
    poNumber: "PO",
    supplierId: "sup-1",
    supplierName: "Supplier One",
    state,
    message: `state ${state}`,
    folderUrl: null,
    poFolderUrl: null,
    folderPath: null,
    styles: [{ styleId: "s1", styleName: "AB10001" }],
    sections: [
      { id: "cover-pages", title: "", description: "", scanned: 1, flagged, ok: [], notes: [] },
      { id: "output-file-names", title: "", description: "", scanned: 1, flagged: [], ok: [], notes: [] },
    ],
    checkedAt: new Date().toISOString(),
  };
}

const flaggedRow = (fileName: string) => ({
  id: `item-${fileName}`,
  fileName,
  webUrl: null,
  size: 1,
  lastModifiedAt: null,
  location: "approved-layouts",
  kind: "file-renamed",
  verdict: "under its generated name",
  detail: null,
  owner: null,
  proposed: "rename",
  allowed: ["rename", "delete"],
  renameTo: "right.pdf",
});

// ── The throttle observer, faked so a test can drive it ────────────────────
let waitMs = 0;
let streak = 0;

let keys: Array<{ supplierId: string; poNumber: string; poSeq: number }> = [];

before(() => {
  mock.module("@/lib/db", { namedExports: { db } });
  mock.module("@/lib/checks/run-po-checks", { namedExports: { runPoChecks } });
  mock.module("@/lib/sharepoint/po-delivery-run", {
    namedExports: { listDeliverablePoKeys: async () => keys },
  });
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getSupplierSendMinPo: async () => 63320 },
  });
  mock.module("@/lib/sharepoint/graph-throttle", {
    namedExports: {
      graphThrottleWaitMs: () => waitMs,
      graphThrottleStreak: () => streak,
      noteGraphSuccess: () => {},
      noteGraphFailure: () => {},
    },
  });
});

beforeEach(() => {
  sweeps = [];
  pos = [];
  // `ids` is deliberately NOT reset: a loop left over from the previous test
  // must not find a NEW sweep sitting under the id it was working on.
  inFlight = 0;
  maxInFlight = 0;
  waitMs = 0;
  streak = 0;
  runPoChecks.mock.resetCalls();
  reportFor = () => report("ok");
  keys = [
    { supplierId: "sup-1", poNumber: "PO-3", poSeq: 3 },
    { supplierId: "sup-1", poNumber: "PO-2", poSeq: 2 },
    { supplierId: "sup-1", poNumber: "PO-1", poSeq: 1 },
  ];
});

const lib = () => import("../src/lib/checks/sweep");

async function waitFor(predicate: () => boolean, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the sweep");
}

const settled = () => waitFor(() => sweeps.length > 0 && sweeps[0].status !== "RUNNING");

test("the whole PO list is written up front — that is what makes it resumable", async () => {
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  assert.equal(pos.length, 3, "every PO has a row before the first folder is opened");
  assert.equal(sweeps[0].totalPos, 3);
  await settled();
});

test("every PO is checked exactly once, newest order first", async () => {
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  await settled();
  assert.deepEqual(
    runPoChecks.mock.calls.map((c) => (c.arguments[0] as { poNumber: string }).poNumber),
    ["PO-3", "PO-2", "PO-1"],
  );
  assert.equal(sweeps[0].status, "DONE");
  assert.equal(sweeps[0].checkedPos, 3);
});

test("ONE folder at a time — the sweep never fans out to go faster", async () => {
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  await settled();
  assert.equal(maxInFlight, 1, "widening this is a Graph rate-limit decision, not a free one");
});

test("findings land per PO as they are checked, not at the end", async () => {
  reportFor = (po) => (po === "PO-2" ? report("ok", [flaggedRow("a.pdf"), flaggedRow("b.pdf")]) : report("ok"));
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  await settled();
  const row = pos.find((p) => p.poNumber === "PO-2")!;
  assert.equal(row.flaggedFiles, 2);
  assert.equal((row.findings as unknown[]).length, 2);
  assert.equal(sweeps[0].flaggedFiles, 2);
  assert.equal(sweeps[0].posWithFindings, 1);
});

test("a resume re-checks only what was still pending", async () => {
  const { startOrResumeSweep, SWEEP_STALE_MS } = await lib();
  await startOrResumeSweep({});
  await settled();

  // Stage the wreckage a deploy leaves: the run is still RUNNING, one folder
  // was never reached, and the heartbeat has gone cold.
  const sweep = sweeps[0];
  sweep.status = "RUNNING";
  sweep.finishedAt = null;
  sweep.heartbeatAt = new Date(Date.now() - SWEEP_STALE_MS - 1000);
  const stranded = pos.find((p) => p.poNumber === "PO-1")!;
  stranded.state = "pending";
  stranded.checkedAt = null;
  runPoChecks.mock.resetCalls();

  const res = await startOrResumeSweep({});
  assert.equal(res.resumed, true);
  await settled();
  assert.deepEqual(
    runPoChecks.mock.calls.map((c) => (c.arguments[0] as { poNumber: string }).poNumber),
    ["PO-1"],
    "the two folders already checked are not paid for twice",
  );
  assert.equal(sweeps.length, 1, "a resume continues the run; it does not start a second one");
});

test("a warm run is never double-started", async () => {
  const { startOrResumeSweep, SweepBusyError } = await lib();
  await startOrResumeSweep({});
  await assert.rejects(() => startOrResumeSweep({}), SweepBusyError);
  await settled();
});

test("Stop is noticed between folders", async () => {
  keys = Array.from({ length: 40 }, (_, i) => ({ supplierId: "sup-1", poNumber: `PO-${i}`, poSeq: 40 - i }));
  const { startOrResumeSweep, cancelSweep } = await lib();
  const { sweepId } = await startOrResumeSweep({});
  await waitFor(() => runPoChecks.mock.callCount() >= 1);
  await cancelSweep(sweepId);
  await settled();
  assert.equal(sweeps[0].status, "CANCELLED");
  assert.ok(runPoChecks.mock.callCount() < 40, "it stopped rather than finishing the book");
});

test("a run of unreadable folders stops the sweep instead of being recorded as results", async () => {
  // The failure this guards against: a Graph outage writing "we looked and
  // found nothing" against every folder in the book.
  keys = Array.from({ length: 30 }, (_, i) => ({ supplierId: "sup-1", poNumber: `PO-${i}`, poSeq: i }));
  reportFor = () => report("unavailable");
  const { startOrResumeSweep, MAX_CONSECUTIVE_UNREADABLE } = await lib();
  await startOrResumeSweep({});
  await settled();
  assert.equal(sweeps[0].status, "FAILED");
  assert.equal(runPoChecks.mock.callCount(), MAX_CONSECUTIVE_UNREADABLE);
  assert.match(String(sweeps[0].error), /could not be read/);
  assert.equal(sweeps[0].unreadablePos, MAX_CONSECUTIVE_UNREADABLE);
  assert.equal(sweeps[0].posWithFindings, 0, "an unreadable folder is never a clean one");
});

test("a readable folder resets the unreadable streak", async () => {
  const seq = ["unavailable", "unavailable", "ok", "unavailable"];
  let i = 0;
  keys = Array.from({ length: 4 }, (_, n) => ({ supplierId: "sup-1", poNumber: `PO-${n}`, poSeq: 4 - n }));
  reportFor = () => report(seq[i++] ?? "ok");
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  await settled();
  assert.equal(sweeps[0].status, "DONE");
  assert.equal(runPoChecks.mock.callCount(), 4);
});

test("a sustained throttle stops the run rather than hammering SharePoint", async () => {
  const { startOrResumeSweep, MAX_THROTTLE_STREAK } = await lib();
  streak = MAX_THROTTLE_STREAK;
  await startOrResumeSweep({});
  await settled();
  assert.equal(sweeps[0].status, "FAILED");
  assert.equal(runPoChecks.mock.callCount(), 0, "not one more folder was opened");
  assert.match(String(sweeps[0].error), /slow down/);
});

test("a throttle wait pauses the loop instead of pushing through it", async () => {
  const { startOrResumeSweep } = await lib();
  waitMs = 60_000;
  await startOrResumeSweep({});
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runPoChecks.mock.callCount(), 0, "it waited; it did not carry on regardless");
  assert.equal(sweeps[0].status, "RUNNING", "waiting is not failing — the run is still alive");
  // And it comes back on its own once Graph stops asking us to wait — after
  // the slice it is currently sleeping through (SLEEP_SLICE_MS) elapses.
  waitMs = 0;
  await waitFor(() => sweeps.length > 0 && sweeps[0].status !== "RUNNING", 12_000);
  assert.equal(sweeps[0].status, "DONE");
  assert.equal(runPoChecks.mock.callCount(), 3);
});

test("a check that throws costs its own folder and nothing else", async () => {
  reportFor = (po) => (po === "PO-2" ? (new Error("boom") as never) : report("ok"));
  const { startOrResumeSweep } = await lib();
  await startOrResumeSweep({});
  await settled();
  assert.equal(sweeps[0].status, "DONE");
  assert.equal(sweeps[0].erroredPos, 1);
  assert.equal(pos.find((p) => p.poNumber === "PO-2")!.state, "error");
  assert.equal(pos.find((p) => p.poNumber === "PO-1")!.state, "ok");
});

test("the sweep never reaches the apply — it only says which folders to open", async () => {
  const mod = await lib();
  const surface = Object.keys(mod).join(" ");
  assert.ok(!/apply/i.test(surface), `the sweep must expose no repair: ${surface}`);
});
