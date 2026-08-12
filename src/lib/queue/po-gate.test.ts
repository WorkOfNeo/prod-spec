import test from "node:test";
import assert from "node:assert/strict";
import { hasPoNumber, HAS_PO_NUMBER_WHERE } from "@/lib/styles/active-filter";

// =====================================================
// The PO-number gate on GENERATION.
//
// #290 gated the /styles LIST on the Monday "Navision Task" cell. These tests
// pin the other half: a style with no PO number must not generate either — not
// via the backlog sweep, not via a sync handoff, not via a bulk action, not via
// a manual re-run. The gate is one predicate (hasPoNumber / HAS_PO_NUMBER_WHERE
// in active-filter.ts) shared by both halves, so the list and the queue can
// never disagree about what "in the flow" means.
//
// Deliberately no DB here: enqueueGenerationJob's own refusal is a one-line
// call through that predicate, and these cover the predicate plus the exact
// cell shapes the Monday sync writes. The DB-backed paths are covered by
// active-filter.test.ts's where-clause interpreter.
// =====================================================

test("PO gate — the cell shapes Monday actually writes", () => {
  // Present: the style is in the flow and may generate. Synthetic numbers —
  // this repo is public, so fixtures never carry a live PO.
  assert.equal(hasPoNumber("10001"), true);
  assert.equal(hasPoNumber("C-PO10001"), true);

  // Absent: the buyer hasn't filled "Navision Task" yet.
  assert.equal(hasPoNumber(null), false, "column absent from the Monday item");
  assert.equal(hasPoNumber(undefined), false, "style row not loaded with poNumber");
  assert.equal(hasPoNumber(""), false, "cell cleared");
});

test("PO gate — a whitespace-only cell is as unset as an empty one", () => {
  // This is the case the SQL half CANNOT catch (see HAS_PO_NUMBER_WHERE's own
  // comment), which is exactly why every generation path re-checks in JS after
  // loading the row instead of trusting the query alone.
  assert.equal(hasPoNumber("   "), false);
  assert.equal(hasPoNumber("\t"), false);
  assert.equal(hasPoNumber("\n "), false);
});

test("PO gate — a PO that doesn't parse numerically still counts as present", () => {
  // The generation cutoff (generationMinPo) filters on Style.poSeq, the parsed
  // numeric part, and admits poSeq IS NULL. That is a DIFFERENT question from
  // this gate: "unparseable PO" must keep generating, "no PO at all" must not.
  // If these two ever collapse into one check, an oddly-formatted PO silently
  // stops generating — so pin the distinction.
  assert.equal(hasPoNumber("PO/2026-A"), true);
  assert.equal(hasPoNumber("tbd"), true);
});

test("PO gate — the SQL half excludes both NULL and empty string", () => {
  // The bulk candidate queries and the sweep prefilter spread this clause in.
  // Asserting its shape keeps a refactor from quietly dropping one of the two
  // states and re-opening the hole for whichever one it forgot.
  assert.deepEqual(HAS_PO_NUMBER_WHERE, { poNumber: { not: null, notIn: [""] } });
});
