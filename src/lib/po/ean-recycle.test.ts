import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eanLane,
  nextRecycleAt,
  eanFloated,
  MAX_EAN_ATTEMPTS,
  RECYCLE_MIN_AGE_MS,
} from "./ean-status-meta";

const NOW = new Date("2026-08-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ------------------------------------------------------------ nextRecycleAt

test("a row checked recently is not due until the age floor passes", () => {
  const lastChecked = ago(1 * DAY);
  const next = nextRecycleAt(lastChecked, 0, NOW);
  assert.equal(next.getTime(), lastChecked.getTime() + RECYCLE_MIN_AGE_MS);
  assert.ok(next.getTime() > NOW.getTime(), "should be in the future");
});

test("a row past the age floor is due now, never a stale past date", () => {
  const next = nextRecycleAt(ago(30 * DAY), 0, NOW);
  assert.equal(next.getTime(), NOW.getTime());
});

test("a never-checked row is due immediately", () => {
  assert.equal(nextRecycleAt(null, 0, NOW).getTime(), NOW.getTime());
});

test("quota backlog pushes the estimate out a day per full quota ahead", () => {
  const old = ago(30 * DAY);
  const quota = 300;
  // Inside the first day's quota → still due now.
  assert.equal(nextRecycleAt(old, 299, NOW, quota).getTime(), NOW.getTime());
  // One full quota ahead → tomorrow.
  assert.equal(nextRecycleAt(old, 300, NOW, quota).getTime(), NOW.getTime() + DAY);
  assert.equal(nextRecycleAt(old, 900, NOW, quota).getTime(), NOW.getTime() + 3 * DAY);
});

test("age floor and quota backlog stack — eligible first, then queue", () => {
  // Checked 1 day ago, so 2 days short of the floor; 900 rows ahead at 300/day
  // adds 3 more days of queue. A row doesn't start queuing until it's due, so
  // the two delays add rather than the larger one swallowing the other.
  const next = nextRecycleAt(ago(1 * DAY), 900, NOW, 300);
  assert.equal(next.getTime(), NOW.getTime() + 2 * DAY + 3 * DAY);
});

// ------------------------------------------------------------------ eanLane

const lane = (over: Partial<Parameters<typeof eanLane>[0]> = {}) =>
  eanLane({
    status: "PO_FOUND_NO_EANS",
    attempts: MAX_EAN_ATTEMPTS + 1,
    poSeq: 70000,
    cutoff: 63320,
    lastCheckedAt: ago(30 * DAY),
    aheadInQueue: 0,
    now: NOW,
    ...over,
  });

test("a gave-up row above the cutoff is cycling, with an estimate", () => {
  const l = lane();
  assert.equal(l.kind, "cycling");
  assert.ok(l.kind === "cycling" && l.nextCheckAt instanceof Date);
});

test("a row below the PO cutoff is parked — never promised a re-check", () => {
  assert.equal(lane({ poSeq: 61000 }).kind, "parked");
  // A style with no PO sequence can't be scoped, so it parks too.
  assert.equal(lane({ poSeq: null }).kind, "parked");
});

test("parked beats cycling — being below the cutoff overrides the strike count", () => {
  assert.equal(lane({ poSeq: 100, attempts: 99 }).kind, "parked");
});

test("a row still inside its fast-lane budget is active, not cycling", () => {
  assert.equal(lane({ attempts: MAX_EAN_ATTEMPTS - 1 }).kind, "active");
});

test("a healthy status never cycles, however many attempts it logged", () => {
  assert.equal(lane({ status: "RESOLVED", attempts: 9 }).kind, "active");
  assert.equal(lane({ status: "PARTIAL", attempts: 9 }).kind, "active");
  assert.equal(lane({ status: "RESOLVED_FROM_MONDAY", attempts: 9 }).kind, "active");
});

test("with no cutoff configured nothing is parked", () => {
  assert.equal(lane({ cutoff: null, poSeq: null }).kind, "cycling");
  assert.equal(lane({ cutoff: null, poSeq: 1 }).kind, "cycling");
});

test("recycle scope agrees with eanFloated — the pile is the same set", () => {
  // The lane only ever reports "cycling" for rows eanFloated() calls floated,
  // so the /po-eans "gave up" count and the recycle queue can't drift apart.
  for (const status of ["PO_FOUND_NO_EANS", "PO_NOT_FOUND", "STYLE_NOT_IN_PO", "ERROR"]) {
    assert.equal(eanFloated(status, MAX_EAN_ATTEMPTS), true, status);
    assert.equal(lane({ status, attempts: MAX_EAN_ATTEMPTS }).kind, "cycling", status);
  }
  for (const status of ["RESOLVED", "PARTIAL", "RESOLVED_FROM_MONDAY", "PENDING", "NONE"]) {
    assert.equal(eanFloated(status, MAX_EAN_ATTEMPTS), false, status);
    assert.equal(lane({ status, attempts: MAX_EAN_ATTEMPTS }).kind, "active", status);
  }
});
