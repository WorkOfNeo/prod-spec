import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignalsTable, formatDrafts, formatDuration, formatRate, formatUsd } from "./signals-table";
import type { OutputSignalRow } from "@/lib/change-requests/signals";

// The signals table is server-rendered on /requests: its formatters, and a
// static render (no hooks, so it renders outside React's client runtime).

test("durations read in the largest sensible unit", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(-5), "—");
  assert.equal(formatDuration(20_000), "<1 min");
  assert.equal(formatDuration(42 * 60_000), "42 min");
  assert.equal(formatDuration(2 * 3_600_000), "2 h");
  assert.equal(formatDuration(2 * 3_600_000 + 14 * 60_000), "2 h 14 min");
  assert.equal(formatDuration(3 * 86_400_000), "3 d");
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 59_000), "3 d 4 h");
});

test("money, rates and drafts", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.001), "<$0.01");
  assert.equal(formatUsd(1.234), "$1.23");
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(2 / 3), "67%");
  assert.equal(formatDrafts(null), "—");
  assert.equal(formatDrafts(2), "2");
  assert.equal(formatDrafts(1.5), "1.5");
});

const row: OutputSignalRow = {
  outputId: "out-1",
  requestId: "req-1",
  requestNumber: 3,
  requestRef: "R-0003",
  label: "Polybag sticker",
  status: "PUBLISHED",
  draftCount: 2,
  firstTryApproved: false,
  editKinds: ["size", "wording"],
  timeToApprovalMs: 90 * 60_000,
  costUsd: 0.42,
  rejectReason: null,
  createdAt: "2026-10-24T10:00:00.000Z",
};

test("renders totals and a row per output, linking to the request", () => {
  const html = renderToStaticMarkup(
    createElement(SignalsTable, {
      rows: [row],
      totals: { requests: 1, outputs: 1, firstTryRate: 0, medianDrafts: 2, totalCostUsd: 0.42 },
    }),
  );
  assert.match(html, /href="\/requests\/req-1"/);
  assert.match(html, /R-0003/);
  assert.match(html, /Published/);
  assert.match(html, /1 h 30 min/);
  assert.match(html, /\$0\.42/);
  assert.match(html, />size</);
  assert.match(html, />wording</);
  assert.match(html, /Latest 1 output across 1 request/);
});

test("renders an empty state with zero totals", () => {
  const html = renderToStaticMarkup(
    createElement(SignalsTable, {
      rows: [],
      totals: { requests: 0, outputs: 0, firstTryRate: null, medianDrafts: null, totalCostUsd: 0 },
    }),
  );
  assert.match(html, /once the agent has drafted a change/);
  assert.doesNotMatch(html, /<table/);
});
