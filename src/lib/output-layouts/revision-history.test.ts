import { test } from "node:test";
import assert from "node:assert/strict";
import type { RevisionSummary } from "./revisions";
import { revisionUserIds, rowActions, toOpenDraftView, toRevisionViews } from "./revision-history";

// The History panel's view mapping and action rules (pure; type-only import of
// revisions.ts, so no DATABASE_URL needed).

function row(over: Partial<RevisionSummary> = {}): RevisionSummary {
  return {
    id: "rev-1",
    layoutId: "bogus-layout",
    number: 1,
    status: "DRAFT",
    baseVersion: 1,
    authorKind: "USER",
    authorUserId: "user-1",
    changeRequestOutputId: null,
    parentRevisionId: null,
    ops: null,
    note: null,
    publishedAt: null,
    publishedById: null,
    publishedVersion: null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    ...over,
  };
}

const EMAILS = new Map([
  ["user-1", "admin@example.com"],
  ["user-2", "other@example.com"],
]);

test("revisionUserIds: authors and publishers, once each, nulls skipped", () => {
  const ids = revisionUserIds([
    row({ authorUserId: "user-1", publishedById: "user-2" }),
    row({ authorKind: "AGENT", authorUserId: null, publishedById: "user-1" }),
    row({ authorUserId: null, publishedById: null }),
  ]);
  assert.deepEqual(ids.sort(), ["user-1", "user-2"]);
});

test("toRevisionViews: USER → email, AGENT → Agent, unknown id → Unknown user; dates as ISO", () => {
  const [user, agent, gone] = toRevisionViews(
    [
      row({ id: "a" }),
      row({
        id: "b",
        authorKind: "AGENT",
        authorUserId: null,
        status: "PUBLISHED",
        publishedById: "user-2",
        publishedAt: new Date("2026-01-03T00:00:00.000Z"),
        publishedVersion: 2,
      }),
      row({ id: "c", authorUserId: "deleted-user" }),
    ],
    EMAILS,
  );
  assert.equal(user.author, "admin@example.com");
  assert.equal(user.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(user.publishedAt, null);
  assert.equal(user.publishedBy, null);

  assert.equal(agent.author, "Agent");
  assert.equal(agent.publishedBy, "other@example.com", "an agent draft shows the admin who published it");
  assert.equal(agent.publishedAt, "2026-01-03T00:00:00.000Z");

  assert.equal(gone.author, "Unknown user");
});

test("toRevisionViews: self-published rows don't repeat the publisher", () => {
  const [v] = toRevisionViews(
    [row({ status: "PUBLISHED", publishedById: "user-1", publishedVersion: 2, publishedAt: new Date(0) })],
    EMAILS,
  );
  assert.equal(v.publishedBy, null);
});

test("toRevisionViews: only a snapshot (base version = published version) has no 'before'", () => {
  const [draft, published, builderSnapshot] = toRevisionViews(
    [
      row({ status: "DRAFT", baseVersion: 3 }),
      row({ status: "PUBLISHED", baseVersion: 3, publishedVersion: 4 }),
      row({ status: "PUBLISHED", baseVersion: 4, publishedVersion: 4 }),
    ],
    EMAILS,
  );
  assert.equal(draft.hasBefore, true);
  assert.equal(published.hasBefore, true);
  assert.equal(builderSnapshot.hasBefore, false);
});

test("rowActions: restores on published rows only; no 'before' for a snapshot or a draft", () => {
  assert.deepEqual(rowActions({ status: "PUBLISHED", hasBefore: true }), {
    compare: true,
    restoreDefinition: true,
    restoreBase: true,
  });
  assert.deepEqual(rowActions({ status: "PUBLISHED", hasBefore: false }), {
    compare: false,
    restoreDefinition: true,
    restoreBase: false,
  });
  for (const status of ["DRAFT", "DISCARDED", "SUPERSEDED"]) {
    assert.deepEqual(
      rowActions({ status, hasBefore: true }),
      { compare: true, restoreDefinition: false, restoreBase: false },
      status,
    );
  }
});

test("toOpenDraftView: links a request only for a change-request draft", () => {
  assert.deepEqual(toOpenDraftView(row({ id: "d", number: 4, changeRequestOutputId: "out-1" }), "req-1"), {
    id: "d",
    number: 4,
    changeRequestOutputId: "out-1",
    requestId: "req-1",
  });
  assert.equal(toOpenDraftView(row({ changeRequestOutputId: null }), "req-1").requestId, null);
  assert.equal(toOpenDraftView(row({ changeRequestOutputId: "out-1" }), null).requestId, null);
});
