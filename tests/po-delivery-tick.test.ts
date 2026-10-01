// The delivery audit rides the existing 5-minute job-runner cron rather than a
// Railway cron service of its own. That makes the JOB RUNNER the thing at risk:
// it renders PDFs on a 300s budget and must not be slowed, stalled or failed by
// an audit riding along. These tests pin the three guards that protect it.
//
// The sweep itself needs Graph and a database, so both are mocked once up front
// and steered per-test through `state` — what is under test is the decision to
// run at all, and how big a slice to take.
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

type SweepArgs = { limit?: number; deadlineAt?: number };

const state = {
  lastRunAgoMs: null as number | null, // null ⇒ never run
  dbThrows: false,
  sweepThrows: false,
  sweepCalls: [] as SweepArgs[],
  created: [] as Array<Record<string, unknown>>,
};

let maybeSweepPoDeliveryTick: (hostStartedAt: number) => Promise<{ ran: boolean; reason?: string }>;

before(async () => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        cronRun: {
          findFirst: async () => {
            if (state.dbThrows) throw new Error("db down");
            return state.lastRunAgoMs == null
              ? null
              : { createdAt: new Date(Date.now() - state.lastRunAgoMs) };
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            state.created.push(data);
            return data;
          },
        },
      },
    },
  });

  mock.module("@/lib/sharepoint/po-delivery-run", {
    namedExports: {
      sweepPoDelivery: async (args: SweepArgs) => {
        state.sweepCalls.push(args);
        if (state.sweepThrows) throw new Error("Graph is down");
        return {
          checked: 3,
          fullyDelivered: 1,
          withShortfall: 2,
          unresolvable: 0,
          skipped: 0,
          ranOutOfTime: false,
          remaining: 40,
        };
      },
    },
  });

  ({ maybeSweepPoDeliveryTick } = await import("@/lib/sharepoint/po-delivery-tick"));
});

beforeEach(() => {
  state.lastRunAgoMs = null;
  state.dbThrows = false;
  state.sweepThrows = false;
  state.sweepCalls = [];
  state.created = [];
});

test("throttle — a tick inside the interval does not sweep", async () => {
  // The host fires every 5 minutes; the audit must not.
  state.lastRunAgoMs = 5 * 60_000;
  const out = await maybeSweepPoDeliveryTick(Date.now());
  assert.deepEqual(out, { ran: false, reason: "not-due" });
  assert.equal(state.sweepCalls.length, 0);
});

test("throttle — past the interval it sweeps, and records the run", async () => {
  state.lastRunAgoMs = 20 * 60_000;
  const out = await maybeSweepPoDeliveryTick(Date.now());
  assert.equal(out.ran, true);
  assert.equal(state.created.length, 1, "the recorded run IS the throttle's clock — it must be written");
  assert.equal(state.created[0].kind, "po-delivery");
});

test("throttle — never having run counts as due", async () => {
  state.lastRunAgoMs = null;
  assert.equal((await maybeSweepPoDeliveryTick(Date.now())).ran, true);
});

test("throttle — an unreadable clock runs rather than stalling forever", async () => {
  // Failing closed would mean one bad query silently disables the audit for good.
  state.dbThrows = true;
  assert.equal((await maybeSweepPoDeliveryTick(Date.now())).ran, true);
});

test("budget — a host that already burned its time contributes nothing", async () => {
  // 290s into a 300s budget: starting Graph calls here pushes the request over.
  const out = await maybeSweepPoDeliveryTick(Date.now() - 290_000);
  assert.deepEqual(out, { ran: false, reason: "no-budget" });
  assert.equal(state.sweepCalls.length, 0, "no slice at all — there is another tick in five minutes");
});

test("budget — the slice is deadlined, and never beyond its own cap", async () => {
  await maybeSweepPoDeliveryTick(Date.now());
  assert.ok(
    (state.sweepCalls[0].deadlineAt as number) <= Date.now() + 60_000,
    "capped at the 60s slice ceiling on a fresh host",
  );

  // A host 260s in has ~40s left; minus the 20s response margin ⇒ ~20s slice.
  state.sweepCalls = [];
  await maybeSweepPoDeliveryTick(Date.now() - 260_000);
  assert.ok(
    (state.sweepCalls[0].deadlineAt as number) < Date.now() + 25_000,
    "a busy host gets a proportionally smaller slice",
  );
});

test("budget — the sweep is always bounded by a limit as well as a clock", async () => {
  // limit bounds Graph SPEND, deadline bounds wall CLOCK. One slow tenant makes
  // them diverge, so the slice needs both.
  await maybeSweepPoDeliveryTick(Date.now());
  const call = state.sweepCalls[0];
  assert.ok(typeof call.limit === "number" && call.limit > 0);
  assert.ok(typeof call.deadlineAt === "number");
});

test("isolation — a Graph outage never fails the host tick", async () => {
  // The host renders PDFs for a living. An audit must not be why that 500s.
  state.sweepThrows = true;
  const out = await maybeSweepPoDeliveryTick(Date.now());
  assert.deepEqual(out, { ran: false, reason: "failed" });
});
