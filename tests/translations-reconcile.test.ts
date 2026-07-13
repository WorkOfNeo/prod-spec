// Reconciliation in syncTranslations: a phrase removed from the Monday board
// (its ghost item not touched by the latest sink — older lastSyncedAt) is
// soft-deactivated, guarded so a transient empty fetch can't mass-disable the
// dictionary. syncTranslations imports @/lib/db, so this runs under the
// module-mock script:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Item = { id: string; name: string; lastSyncedAt: Date };
type Trans = { key: string; active: boolean };

// A tiny in-memory Prisma stand-in, re-seeded per test.
let ghostItems: Item[] = [];
let translations: Trans[] = [];
const calls = {
  upserts: [] as string[],
  updateManys: [] as Array<{ keys: string[]; data: { active: boolean } }>,
};

function resetDb(items: Item[], trans: Trans[]) {
  ghostItems = items;
  translations = trans;
  calls.upserts = [];
  calls.updateManys = [];
}

// Language values are irrelevant to reconciliation — stub the cell reader.
mock.module("@/lib/import/heuristics", {
  namedExports: { readGhostColumnText: () => "" },
});
mock.module("@/lib/db", {
  namedExports: {
    db: {
      mondayGhostBoard: { findUnique: async () => ({ id: "b1" }) },
      mondayGhostColumn: {
        findMany: async () => [{ mondayColumnId: "c_da", title: "Danish", type: "text" }],
      },
      mondayGhostItem: {
        // Honour the reconcile filter: only items touched at/after freshSince.
        findMany: async ({ where }: { where?: { lastSyncedAt?: { gte?: Date } } }) => {
          const gte = where?.lastSyncedAt?.gte;
          return ghostItems
            .filter((it) => (gte ? it.lastSyncedAt >= gte : true))
            .map((it) => ({ mondayItemId: it.id, name: it.name, groupTitle: null, columnValues: {} }));
        },
      },
      translation: {
        upsert: async ({ where }: { where: { key: string } }) => {
          calls.upserts.push(where.key);
          const row = translations.find((t) => t.key === where.key);
          if (row) row.active = true;
          else translations.push({ key: where.key, active: true });
        },
        findMany: async ({ where }: { where?: { active?: boolean } }) =>
          translations
            .filter((t) => (where?.active === true ? t.active : true))
            .map((t) => ({ key: t.key })),
        updateMany: async ({
          where,
          data,
        }: {
          where: { key: { in: string[] } };
          data: { active: boolean; lastSyncedAt?: Date };
        }) => {
          const keys = where.key.in;
          calls.updateManys.push({ keys, data: { active: data.active } });
          for (const t of translations) if (keys.includes(t.key)) t.active = data.active;
          return { count: keys.length };
        },
      },
    },
  },
});

type Mod = typeof import("@/lib/monday/translations");
let mod: Mod;
before(async () => {
  mod = await import("@/lib/monday/translations");
});
beforeEach(() => resetDb([], []));

const OLD = new Date("2020-01-01T00:00:00.000Z");
const FRESH = new Date("2030-01-01T00:00:00.000Z");
const FRESH_SINCE = new Date("2025-01-01T00:00:00.000Z");

test("reconcile — a phrase no longer on the board is soft-deactivated", async () => {
  resetDb(
    [
      { id: "1", name: "Made in China", lastSyncedAt: FRESH },
      { id: "2", name: "Wash at 30°C", lastSyncedAt: FRESH },
      { id: "3", name: "Retired phrase", lastSyncedAt: OLD }, // removed on Monday
    ],
    [
      { key: "made in china", active: true },
      { key: "wash at 30°c", active: true },
      { key: "retired phrase", active: true },
    ],
  );

  const r = await mod.syncTranslations({ freshSince: FRESH_SINCE });

  // Only the two live phrases were scanned/upserted; the deleted one was not.
  assert.deepEqual(calls.upserts.sort(), ["made in china", "wash at 30°c"]);
  // Exactly the stale phrase was deactivated.
  assert.equal(calls.updateManys.length, 1);
  assert.deepEqual(calls.updateManys[0].keys, ["retired phrase"]);
  assert.equal(calls.updateManys[0].data.active, false);
  assert.equal(r.deactivated, 1);
  assert.equal(translations.find((t) => t.key === "retired phrase")!.active, false);
});

test("reconcile — nothing removed → no deactivation", async () => {
  resetDb(
    [
      { id: "1", name: "Made in China", lastSyncedAt: FRESH },
      { id: "2", name: "Wash at 30°C", lastSyncedAt: FRESH },
    ],
    [
      { key: "made in china", active: true },
      { key: "wash at 30°c", active: true },
    ],
  );

  const r = await mod.syncTranslations({ freshSince: FRESH_SINCE });

  assert.equal(calls.updateManys.length, 0);
  assert.equal(r.deactivated, 0);
});

test("reconcile guard — an empty live set never mass-disables the dictionary", async () => {
  // Every ghost item predates freshSince (e.g. a transient/failed fetch): the
  // live set is empty, so reconciliation must be skipped even though active
  // rows exist.
  resetDb(
    [
      { id: "1", name: "Made in China", lastSyncedAt: OLD },
      { id: "2", name: "Wash at 30°C", lastSyncedAt: OLD },
    ],
    [
      { key: "made in china", active: true },
      { key: "wash at 30°c", active: true },
    ],
  );

  const r = await mod.syncTranslations({ freshSince: FRESH_SINCE });

  assert.equal(calls.updateManys.length, 0);
  assert.equal(r.deactivated, 0);
  assert.ok(translations.every((t) => t.active)); // dictionary untouched
});

test("no freshSince (transformOnly) — reconciliation is skipped entirely", async () => {
  resetDb(
    [
      { id: "1", name: "Made in China", lastSyncedAt: FRESH },
      { id: "3", name: "Retired phrase", lastSyncedAt: OLD },
    ],
    [
      { key: "made in china", active: true },
      { key: "retired phrase", active: true },
    ],
  );

  const r = await mod.syncTranslations(); // no opts → scan all, never deactivate

  assert.deepEqual(calls.upserts.sort(), ["made in china", "retired phrase"]);
  assert.equal(calls.updateManys.length, 0);
  assert.equal(r.deactivated, 0);
});
