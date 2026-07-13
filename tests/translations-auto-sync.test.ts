// Coalescing guard for the translations auto-sync (autoSyncTranslations).
// The module transitively imports @/lib/settings/app-settings → @/lib/db,
// which throws without a DATABASE_URL at import time, so this runs under the
// module-mock script:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// In-memory stand-in for the AppSetting-backed sync state.
const store = { requestedAt: "", runningAt: "" };
function setStore(s: { requestedAt: string; runningAt: string }) {
  store.requestedAt = s.requestedAt;
  store.runningAt = s.runningAt;
}

// Instrumented dependencies — counters + a hook to inject mid-run behaviour.
let sinkCalls = 0;
let transformCalls = 0;
let kicks = 0;
let onSink: () => Promise<void> = async () => {};

mock.module("@/lib/settings/app-settings", {
  namedExports: {
    getTranslationSyncState: async () => ({ ...store }),
    setTranslationSyncState: async (s: { requestedAt: string; runningAt: string }) => setStore(s),
  },
});
mock.module("@/lib/monday/sink", {
  namedExports: {
    sinkBoard: async () => {
      sinkCalls++;
      await onSink();
      return {};
    },
  },
});
mock.module("@/lib/monday/translations", {
  namedExports: {
    syncTranslations: async () => {
      transformCalls++;
      return {
        columnsMapped: 0,
        unmappedColumns: [],
        itemsScanned: 0,
        translationsUpserted: 0,
        deactivated: 0,
      };
    },
  },
});
mock.module("@/lib/queue/trigger", {
  namedExports: {
    triggerTranslationsSync: async () => {
      kicks++;
    },
  },
});

type Mod = typeof import("@/lib/monday/translations-auto-sync");
let mod: Mod;
before(async () => {
  mod = await import("@/lib/monday/translations-auto-sync");
});
beforeEach(() => {
  sinkCalls = 0;
  transformCalls = 0;
  kicks = 0;
  onSink = async () => {};
  setStore({ requestedAt: "", runningAt: "" });
});

test("idle → claims the slot, runs the sink+transform once, releases", async () => {
  const r = await mod.autoSyncTranslations();
  assert.equal(r.status, "synced");
  assert.equal(sinkCalls, 1);
  assert.equal(transformCalls, 1);
  assert.equal(kicks, 0); // no new demand arrived → no trailing re-kick
  assert.equal(store.runningAt, ""); // slot released in finally
});

test("a fresh run already holds the slot → coalesces, records demand, no second sink", async () => {
  const heldAt = new Date().toISOString();
  setStore({ requestedAt: "", runningAt: heldAt });

  const r = await mod.autoSyncTranslations();

  assert.equal(r.status, "coalesced");
  assert.equal(sinkCalls, 0);
  assert.equal(transformCalls, 0);
  assert.equal(store.runningAt, heldAt); // the active run's slot is untouched
  assert.notEqual(store.requestedAt, ""); // demand recorded so the active run drains it
});

test("a stale run (crashed mid-sink, >10 min) is re-claimable", async () => {
  setStore({
    requestedAt: "",
    runningAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  });

  const r = await mod.autoSyncTranslations();

  assert.equal(r.status, "synced");
  assert.equal(sinkCalls, 1); // claimed past the stale slot instead of coalescing
});

test("new demand arriving mid-run triggers exactly one trailing re-kick", async () => {
  // Simulate a webhook landing while the sink runs: it bumps requestedAt past
  // the high-water mark this run captured, so step 4 must drain it once.
  onSink = async () => {
    store.requestedAt = new Date(Date.now() + 1000).toISOString();
  };

  const r = await mod.autoSyncTranslations();

  assert.equal(r.status, "synced");
  assert.equal(sinkCalls, 1);
  assert.equal(kicks, 1);
});
