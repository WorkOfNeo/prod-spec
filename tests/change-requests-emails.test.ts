// sendRequesterUpdate (src/lib/change-requests/emails.ts): who it writes to,
// what rides along, and that it is FAIL-SOFT — an update email is a courtesy on
// top of a state change that already happened, so nothing here may throw into
// the action that triggered it.
//
// Requires Node's module-mock API:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.PROD_SPEC_BASE_URL = "https://prodspec.example.com/";

type Row = Record<string, unknown>;
let requestRow: Row | null;
let userRow: Row | null;
let dispatchThrows = false;
const dispatchEmail = mock.fn(async (input: Row) => {
  if (dispatchThrows) throw new Error("smtp down");
  return { status: "SIMULATED", type: input.type, to: input.to };
});

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        changeRequest: { findUnique: async () => requestRow },
        user: { findUnique: async () => userRow },
      },
    },
  });
  mock.module("@/lib/email/dispatch", { namedExports: { dispatchEmail } });
});

beforeEach(() => {
  requestRow = {
    id: "cr-1",
    number: 12,
    title: "Polybag sticker · PO-0000",
    poNumber: "PO-0000",
    styleId: "style-1",
    createdById: "reviewer-1",
    outputs: [
      { id: "out-1", label: "Polybag sticker", styleId: "style-9" },
      { id: "out-2", label: "Care label", styleId: null },
    ],
  };
  userRow = { email: "reviewer@example.com" };
  dispatchThrows = false;
  dispatchEmail.mock.resetCalls();
});

test("live: to the creator, about the output, linking the request, proofs attached", async () => {
  const { sendRequesterUpdate } = await import("../src/lib/change-requests/emails");
  const outcome = await sendRequesterUpdate("cr-1", "live", {
    outputId: "out-1",
    beforePng: Buffer.from([1]),
    afterPng: Buffer.from([2, 3]),
  });
  assert.ok(outcome);
  assert.equal(dispatchEmail.mock.callCount(), 1);
  const sent = dispatchEmail.mock.calls[0].arguments[0] as {
    type: string;
    to: string;
    subject: string;
    html: string;
    styleId: string;
    attachments: Array<{ filename: string; content: Buffer }>;
  };
  assert.equal(sent.type, "CHANGE_REQUEST_UPDATE");
  assert.equal(sent.to, "reviewer@example.com");
  assert.equal(sent.subject, "[Prod Spec] R-0012 is live — Polybag sticker");
  assert.match(sent.html, /href="https:\/\/prodspec\.example\.com\/requests\/cr-1"/);
  assert.deepEqual(
    sent.attachments.map((a) => [a.filename, a.content.byteLength]),
    [
      ["R-0012-before.png", 1],
      ["R-0012-after.png", 2],
    ],
  );
  assert.equal(sent.styleId, "style-9");
});

test("received: no attachments, the request's style for the log", async () => {
  const { sendRequesterUpdate } = await import("../src/lib/change-requests/emails");
  await sendRequesterUpdate("cr-1", "received");
  const sent = dispatchEmail.mock.calls[0].arguments[0] as { attachments?: unknown; styleId: string; subject: string };
  assert.equal(sent.attachments, undefined);
  assert.equal(sent.styleId, "style-1");
  assert.match(sent.subject, /R-0012 received/);
});

test("no request or no creator email: nothing is sent, nothing throws", async () => {
  const { sendRequesterUpdate } = await import("../src/lib/change-requests/emails");
  requestRow = null;
  assert.equal(await sendRequesterUpdate("cr-1", "received"), null);
  requestRow = { id: "cr-1", number: 1, title: "t", poNumber: null, styleId: null, createdById: "x", outputs: [] };
  userRow = null;
  assert.equal(await sendRequesterUpdate("cr-1", "received"), null);
  assert.equal(dispatchEmail.mock.callCount(), 0);
});

test("a failing send is logged and swallowed", async () => {
  const { sendRequesterUpdate } = await import("../src/lib/change-requests/emails");
  dispatchThrows = true;
  const errors = mock.method(console, "error", () => {});
  try {
    assert.equal(await sendRequesterUpdate("cr-1", "rejected", { outputId: "out-2", message: "No" }), null);
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    errors.mock.restore();
  }
});
