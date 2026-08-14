import { test } from "node:test";
import assert from "node:assert/strict";
import { coverContentIsStale, type CoverContentStamp } from "./app-settings";

// coverContentIsStale decides whether /settings/cover-page shows "cover text
// changed — existing bundles still show the old version". Getting it wrong in
// either direction is bad: a false negative means an edit silently never
// reaches suppliers, a false positive means a banner nobody can clear.

const stamp = (s: Partial<CoverContentStamp>): CoverContentStamp => ({
  changedAt: null,
  regeneratedAt: null,
  dismissedAt: null,
  ...s,
});

const T0 = "2026-08-12T10:00:00.000Z";
const T1 = "2026-08-12T11:00:00.000Z";
const T2 = "2026-08-12T12:00:00.000Z";

test("nothing edited ⇒ never stale", () => {
  assert.equal(coverContentIsStale(stamp({})), false);
  assert.equal(coverContentIsStale(stamp({ regeneratedAt: T1, dismissedAt: T1 })), false);
});

test("edited with no regen and no dismiss ⇒ stale", () => {
  assert.equal(coverContentIsStale(stamp({ changedAt: T1 })), true);
});

test("a regen AFTER the edit settles it; a regen BEFORE does not", () => {
  assert.equal(coverContentIsStale(stamp({ changedAt: T1, regeneratedAt: T2 })), false);
  // The classic trap: swept, then edited again. Must go stale again.
  assert.equal(coverContentIsStale(stamp({ changedAt: T2, regeneratedAt: T1 })), true);
});

test("dismiss settles it, and a later edit un-dismisses", () => {
  assert.equal(coverContentIsStale(stamp({ changedAt: T1, dismissedAt: T2 })), false);
  assert.equal(coverContentIsStale(stamp({ changedAt: T2, dismissedAt: T1 })), true);
});

test("needs to be newer than BOTH — an old dismiss can't mask a fresh edit", () => {
  // Dismissed long ago, regenerated since, then edited: stale.
  assert.equal(
    coverContentIsStale(stamp({ changedAt: T2, regeneratedAt: T1, dismissedAt: T0 })),
    true,
  );
  // Edited, then dismissed, then a regen — both settle it.
  assert.equal(
    coverContentIsStale(stamp({ changedAt: T0, regeneratedAt: T2, dismissedAt: T1 })),
    false,
  );
  // Regen predates the edit but a dismiss postdates it ⇒ settled (the operator
  // explicitly waved it away knowing the covers were stale).
  assert.equal(
    coverContentIsStale(stamp({ changedAt: T1, regeneratedAt: T0, dismissedAt: T2 })),
    false,
  );
});

test("garbage timestamps degrade to not-stale rather than a stuck banner", () => {
  assert.equal(coverContentIsStale(stamp({ changedAt: "not-a-date" })), false);
  // An unparseable settle stamp is ignored, so a real edit still shows.
  assert.equal(coverContentIsStale(stamp({ changedAt: T1, regeneratedAt: "nope" })), true);
});

test("equal timestamps are not stale (a regen that lands in the same ms wins)", () => {
  assert.equal(coverContentIsStale(stamp({ changedAt: T1, regeneratedAt: T1 })), false);
});
