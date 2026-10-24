import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

test("the sweep is a no-op while the feature flag is off", async () => {
  const prev = process.env.CHANGE_REQUESTS_ENABLED;
  delete process.env.CHANGE_REQUESTS_ENABLED;
  try {
    const { changeRequestSweep } = await import("./sweep");
    assert.equal(await changeRequestSweep(), null);
  } finally {
    if (prev !== undefined) process.env.CHANGE_REQUESTS_ENABLED = prev;
  }
});
