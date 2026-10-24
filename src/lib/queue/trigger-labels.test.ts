import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coverNotifiesSupplier, triggerKind, triggerLabel } from "./trigger-labels";

test("a change-request rerun is a manual run labelled 'change request'", () => {
  assert.equal(triggerLabel("CHANGE_REQUEST"), "change request");
  assert.equal(triggerKind("CHANGE_REQUEST"), "manual");
});

test("existing labels and kinds are unchanged", () => {
  assert.equal(triggerLabel("MANUAL_BULK"), "bulk run");
  assert.equal(triggerKind("MANUAL_BULK"), "manual");
  assert.equal(triggerKind("WEBHOOK"), "automated");
  assert.equal(triggerKind("CRON_SWEEP"), "automated");
});

// Rail 3 of the change-requests design: a rerun started by a change request
// never re-arms the supplier digest. Every other trigger keeps notifying.
test("only a change-request rerun re-arms the cover silently", () => {
  assert.equal(coverNotifiesSupplier("CHANGE_REQUEST"), false);
  for (const source of [
    "WEBHOOK",
    "MANUAL_RERUN",
    "ADMIN_TEST",
    "MANUAL_IMPORT",
    "TICKET_RERUN",
    "TICKET_FIX",
    "EAN_RESOLVED",
    "CRON_SWEEP",
    "MANUAL_BULK",
  ]) {
    assert.equal(coverNotifiesSupplier(source), true, source);
  }
});

// processJob has no seam to drive a cover re-arm without the whole render
// chain, so this reads the source instead: EVERY place the runner re-arms a
// cover must derive notifySupplier from the job's trigger. A new call site
// that forgets it would put change-request reruns back into the supplier
// digest — fail here instead.
test("the runner derives notifySupplier from the trigger at every cover re-arm", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/queue/runner.ts"), "utf8");
  // [^;] spans newlines, so a call split over several lines is captured whole.
  const calls = [...src.matchAll(/enqueueCoverForSupplier\(([^;]*?)\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 2, "expected the two runner call sites (fully-approved refresh + normal run)");
  for (const args of calls) {
    assert.match(args, /notifySupplier:\s*coverNotifiesSupplier\(job\.triggerSource\)/, args);
  }
});
