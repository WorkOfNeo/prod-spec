import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLANK_VALUE,
  EMPTY_FACETS,
  buildFacetMatcher,
  matchesFacets,
  reviewerValue,
  customerValue,
  sameSet,
  type FacetKey,
  type FacetableRow,
} from "./table-filter";

const row = (o: Partial<FacetableRow> = {}): FacetableRow => ({
  customerName: "Netto",
  businessArea: "Private Label",
  groupTitle: "Week 32",
  statusView: { key: "AWAITING_REVIEW" },
  eanStatus: "OK",
  reviewerName: null,
  ...o,
});

const facets = (o: Partial<Record<FacetKey, string[]>>) => ({ ...EMPTY_FACETS, ...o });

// ── Client (customer) ──────────────────────────────────────────────────────
test("client facet keeps only the picked clients, OR'd within the facet", () => {
  const netto = row({ customerName: "Netto" });
  const coop = row({ customerName: "Coop" });
  const rema = row({ customerName: "Rema" });
  const match = buildFacetMatcher(facets({ customer: ["Netto", "Coop"] }));
  assert.deepEqual([netto, coop, rema].filter(match), [netto, coop]);
});

test("a client name is trimmed, and an empty one collapses to the blank sentinel", () => {
  assert.equal(customerValue(row({ customerName: "  Netto " })), "Netto");
  assert.equal(customerValue(row({ customerName: "   " })), BLANK_VALUE);
  assert.ok(matchesFacets(row({ customerName: "" }), facets({ customer: [BLANK_VALUE] })));
});

// ── Reviewer (who is reviewing) ────────────────────────────────────────────
test("reviewer facet filters by who claimed the review", () => {
  const mine = row({ reviewerName: "Niels" });
  const theirs = row({ reviewerName: "Ida" });
  const nobody = row({ reviewerName: null });
  const match = buildFacetMatcher(facets({ reviewer: ["Niels"] }));
  assert.deepEqual([mine, theirs, nobody].filter(match), [mine]);
});

test("unclaimed reviews are selectable as the blank sentinel, not dropped", () => {
  assert.equal(reviewerValue(row({ reviewerName: null })), BLANK_VALUE);
  assert.equal(reviewerValue(row({ reviewerName: "   " })), BLANK_VALUE);
  assert.equal(reviewerValue(row({ reviewerName: " Ida " })), "Ida");
  const nobody = row({ reviewerName: null });
  const claimed = row({ reviewerName: "Ida" });
  const match = buildFacetMatcher(facets({ reviewer: [BLANK_VALUE] }));
  assert.deepEqual([nobody, claimed].filter(match), [nobody]);
});

// ── Combination ────────────────────────────────────────────────────────────
test("facets AND across, OR within — client AND reviewer together", () => {
  const wanted = row({ customerName: "Netto", reviewerName: "Ida" });
  const wrongClient = row({ customerName: "Coop", reviewerName: "Ida" });
  const wrongReviewer = row({ customerName: "Netto", reviewerName: "Niels" });
  const match = buildFacetMatcher(facets({ customer: ["Netto"], reviewer: ["Ida"] }));
  assert.deepEqual([wanted, wrongClient, wrongReviewer].filter(match), [wanted]);
});

test("no selection = no filtering (every row survives)", () => {
  const rows = [row(), row({ customerName: "Coop", reviewerName: "Ida" })];
  assert.deepEqual(rows.filter(buildFacetMatcher(EMPTY_FACETS)), rows);
});

// The pre-existing facets must keep working through the extracted matcher —
// this is a refactor of the filter loop, not just an addition.
test("business area, group, status and EAN still filter", () => {
  const r = row({ businessArea: "–", groupTitle: null, statusView: { key: "READY" }, eanStatus: "PENDING" });
  assert.ok(matchesFacets(r, facets({ ba: [BLANK_VALUE] })), "a '–' business area reads as blank");
  assert.ok(matchesFacets(r, facets({ group: [BLANK_VALUE] })), "a null group reads as blank");
  assert.ok(matchesFacets(r, facets({ status: ["READY"] })));
  assert.ok(matchesFacets(r, facets({ ean: ["PENDING"] })));
  assert.ok(!matchesFacets(r, facets({ status: ["AWAITING_REVIEW"] })));
});

test("sameSet ignores order", () => {
  assert.ok(sameSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameSet(["a"], ["a", "b"]));
  assert.ok(sameSet([], []));
});
