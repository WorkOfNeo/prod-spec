// Scoring a bench run: the verdict read off the hand-off, the token check, the
// placement distance and its tolerance, the control-style check and the
// weights. Pure — the cases are the real case files, the outcomes are built
// by hand (no model, no rendering).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyLayoutOps, type LayoutOp } from "@/lib/output-layouts/ops";
import { loadBenchCase, parseBenchCase, type BenchCase } from "./case-schema";
import {
  MAX_WARNING_PENALTY,
  SCORE_WEIGHTS,
  WARNING_PENALTY,
  changedBlocks,
  gapKeyMatches,
  lineTokenKeys,
  scoreCase,
  verdictOf,
  type BenchOutcome,
} from "./score";

const CASES = resolve(__dirname, "../../../../scripts/cr-bench/cases");
const polybag = loadBenchCase(`${CASES}/polybag-qty.json`).case;
const gap = loadBenchCase(`${CASES}/polybag-qty-gap.json`).case;
const socks = loadBenchCase(`${CASES}/socks-composition.json`).case;

const QTY_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';
const rect = (col: number, row: number, colSpan = 27, rowSpan = 4) => ({ col, row, colSpan, rowSpan });

function draft(c: BenchCase, ops: LayoutOp[]) {
  const r = applyLayoutOps(c.layout.definition, ops);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  return { definition: r.def, ops: r.applied };
}

function qtyBlock(col = 7, row = 42, lines = [QTY_LINE], fontPt = 7): LayoutOp {
  return { op: "add_block", page: 0, block: { rect: rect(col, row), fontPt, lines } };
}

function finished(c: BenchCase, ops: LayoutOp[], extra: Partial<BenchOutcome> = {}): BenchOutcome {
  return { terminal: { name: "finish", input: { summary: "done" } }, drafts: [draft(c, ops)], warnings: [], ...extra };
}

const allUnchangedBut = (c: BenchCase, changed: string[]) =>
  c.styles.map((s) => ({ styleId: s.id, changed: changed.includes(s.id) }));

// ── Verdicts ─────────────────────────────────────────────────────────────────

test("verdict: finish with a draft = patch, declare_gap = gap, ask_reviewer = question, otherwise none", () => {
  const d = [draft(polybag, [qtyBlock()])];
  assert.equal(verdictOf({ terminal: { name: "finish", input: {} }, drafts: d }), "patch");
  assert.equal(verdictOf({ terminal: { name: "finish", input: {} }, drafts: [] }), "none");
  assert.equal(verdictOf({ terminal: { name: "declare_gap", input: {} }, drafts: [] }), "gap");
  assert.equal(verdictOf({ terminal: { name: "ask_reviewer", input: {} }, drafts: d }), "question");
  assert.equal(verdictOf({ drafts: d }), "none");
});

test("patch case: the reference answer scores 100", () => {
  const s = scoreCase(polybag, finished(polybag, [qtyBlock()], { impact: allUnchangedBut(polybag, ["style-5pcs", "style-2pcs"]) }));
  assert.equal(s.verdict, "patch");
  assert.equal(s.verdictOk, true);
  assert.equal(s.tokensOk, true);
  assert.deepEqual(s.placement, { found: true, distance: 0, withinTolerance: true });
  assert.equal(s.controlUnchanged, true);
  assert.equal(s.warnings, 0);
  assert.equal(s.total, 100);
});

test("patch case: finishing without a draft scores 0 and says so", () => {
  const s = scoreCase(polybag, { terminal: { name: "finish", input: { summary: "no change needed" } }, drafts: [], warnings: [] });
  assert.equal(s.verdict, "none");
  assert.equal(s.verdictOk, false);
  assert.equal(s.tokensOk, false);
  assert.deepEqual(s.placement, { found: false, distance: -1, withinTolerance: false });
  assert.equal(s.total, 0);
  assert.ok(s.notes.some((n) => n.includes("finished without a draft")));
});

test("patch case: a good draft handed over as a question keeps the work, loses the verdict", () => {
  const o = finished(polybag, [qtyBlock()], { impact: allUnchangedBut(polybag, ["style-5pcs", "style-2pcs"]) });
  const s = scoreCase(polybag, { ...o, terminal: { name: "ask_reviewer", input: { question: "Like this?" } } });
  assert.equal(s.verdict, "question");
  assert.equal(s.verdictOk, false);
  assert.equal(s.total, 100 - SCORE_WEIGHTS.patch.verdict);
});

test("gap case: the declared key must match, or contain the expected key's last word", () => {
  const declare = (tokenKey: string): BenchOutcome => ({
    terminal: { name: "declare_gap", input: { tokenKey } },
    drafts: [],
    warnings: [],
  });
  assert.equal(scoreCase(gap, declare("polybagQty")).total, 100);
  assert.equal(scoreCase(gap, declare("qtyPerSolidPolybag")).total, 100);
  const wrong = scoreCase(gap, declare("piecesPerBag"));
  assert.equal(wrong.verdictOk, true);
  assert.equal(wrong.tokensOk, false);
  assert.equal(wrong.total, SCORE_WEIGHTS.gap.verdict);

  // Faking it with fixed text instead of handing over scores nothing.
  const faked = finished(gap, [qtyBlock(7, 42, ["5 PCS"])]);
  const s = scoreCase(gap, faked);
  assert.equal(s.verdict, "patch");
  assert.equal(s.total, 0);
  assert.ok(s.notes.includes("no gap declared"));
});

test("gapKeyMatches: exact (any case) or the last camel-case word", () => {
  assert.equal(gapKeyMatches("POLYBAGQTY", "polybagQty"), true);
  assert.equal(gapKeyMatches("solidQty", "polybagQty"), true);
  assert.equal(gapKeyMatches("polybagPieces", "polybagQty"), false);
  assert.equal(gapKeyMatches("netPrice", "price"), true);
  assert.equal(gapKeyMatches("", "price"), false);
});

test("question case: only the verdict counts", () => {
  const raw = JSON.parse(JSON.stringify({ ...polybag, expected: { verdict: "question" } }));
  const q = parseBenchCase(raw);
  assert.equal(scoreCase(q, { terminal: { name: "ask_reviewer", input: { question: "Which?" } }, drafts: [], warnings: [] }).total, 100);
  assert.equal(scoreCase(q, finished(q, [qtyBlock()])).total, 0);
});

// ── Placement ────────────────────────────────────────────────────────────────

test("placement: full marks when exact, half at the tolerance, nothing beyond it", () => {
  const impact = allUnchangedBut(polybag, ["style-5pcs", "style-2pcs"]);
  const w = SCORE_WEIGHTS.patch;
  const at = (col: number, row: number) => scoreCase(polybag, finished(polybag, [qtyBlock(col, row)], { impact }));

  const near = at(10, 39); // |3| + |3| = 6 of tolerance 12
  assert.deepEqual(near.placement, { found: true, distance: 6, withinTolerance: true });
  assert.equal(near.total, Math.round(100 - w.placement * 0.25));

  const edge = at(13, 36); // 6 + 6 = 12, exactly the tolerance
  assert.deepEqual(edge.placement, { found: true, distance: 12, withinTolerance: true });
  assert.equal(edge.total, Math.round(100 - w.placement * 0.5));

  const far = at(2, 20); // 5 + 22 = 27: overlaps the barcode, far from the price
  assert.equal(far.placement?.withinTolerance, false);
  assert.equal(far.total, 100 - w.placement);
});

test("placement: the block must carry every lineIncludes substring; the closest candidate counts", () => {
  const impact = allUnchangedBut(polybag, ["style-5pcs", "style-2pcs"]);
  const notQty = scoreCase(polybag, finished(polybag, [qtyBlock(7, 42, ["PCS"])], { impact }));
  assert.equal(notQty.placement?.found, false);
  assert.equal(notQty.tokensOk, false);

  const two = scoreCase(
    polybag,
    finished(polybag, [qtyBlock(20, 41), { op: "add_block", page: 0, block: { rect: rect(8, 43), fontPt: 7, lines: [QTY_LINE] } }], {
      impact,
    }),
  );
  assert.equal(two.placement?.distance, 2);
});

test("changedBlocks: added blocks, edited lines and moved rects — not untouched ones", () => {
  const d = draft(polybag, [
    qtyBlock(),
    { op: "edit_line", page: 0, blockId: "b-price", line: 0, oldText: "{{price}} €", newText: "{{price}} EUR" },
    { op: "set_rect", page: 0, blockId: "b-article", rect: rect(2, 1, 46, 5) },
  ]);
  const changed = changedBlocks(polybag.layout.definition, d.definition);
  assert.deepEqual(
    changed.map((c) => [c.block.id, c.added, c.newLines]),
    [
      ["b-article", false, []],
      ["b-price", false, ["{{price}} EUR"]],
      ["b-add1", true, [QTY_LINE]],
    ],
  );
});

// ── Tokens ───────────────────────────────────────────────────────────────────

test("lineTokenKeys: tokens, conditional fields and calc fields", () => {
  assert.deepEqual(lineTokenKeys(QTY_LINE).sort(), ["polybagQty"]);
  assert.deepEqual(
    lineTokenKeys('{{if productGroup == "Socks"}}{{composition:fi}}{{endif}} {{= qtyPerCarton * 2 }}').sort(),
    ["composition", "productGroup", "qtyPerCarton"],
  );
});

test("tokens: alternatives with |, and only lines the draft adds or changes count", () => {
  const socksBlock = (lines: string[]): LayoutOp => ({
    op: "add_block",
    page: 0,
    block: { rect: { col: 2, row: 35, colSpan: 36, rowSpan: 11 }, fontPt: 5, lines },
  });
  const impact = allUnchangedBut(socks, ["style-socks", "style-wool-socks"]);
  const good = scoreCase(
    socks,
    finished(
      socks,
      [
        socksBlock([
          '{{if productGroup == "Socks"}}{{compositionLines:fi}}{{endif}}',
          '{{if productGroup == "Socks"}}{{washSymbols}}{{endif}}',
        ]),
      ],
      { impact },
    ),
  );
  assert.equal(good.tokensOk, true);
  assert.equal(good.total, 100);

  const noSymbols = scoreCase(
    socks,
    finished(socks, [socksBlock(['{{if productGroup == "Socks"}}{{composition:fi}} {{composition:sv}}{{endif}}'])], { impact }),
  );
  assert.equal(noSymbols.tokensOk, false);
  assert.ok(noSymbols.notes.some((n) => n.includes("washSymbols")));
  // No placement expected on this case: weights scale over verdict + tokens + control.
  const w = SCORE_WEIGHTS.patch;
  assert.equal(noSymbols.total, Math.round((100 * (w.verdict + w.control)) / (w.verdict + w.tokens + w.control)));
});

// ── Control ──────────────────────────────────────────────────────────────────

test("control: a changed control style fails the check; no impact data drops it with a note", () => {
  const ops = [qtyBlock()];
  const w = SCORE_WEIGHTS.patch;
  const changed = scoreCase(polybag, finished(polybag, ops, { impact: allUnchangedBut(polybag, ["style-5pcs", "style-1pc"]) }));
  assert.equal(changed.controlUnchanged, false);
  assert.equal(changed.total, 100 - w.control);
  assert.ok(changed.notes.some((n) => n.includes("control changed: style-1pc")));
  assert.ok(changed.notes.some((n) => n.includes("style-2pcs") && n.includes("does not change")));

  const unknown = scoreCase(polybag, finished(polybag, ops));
  assert.equal(unknown.controlUnchanged, undefined);
  assert.equal(unknown.total, 100);
  assert.ok(unknown.notes.some((n) => n.includes("no impact data")));
});

// ── Warnings ─────────────────────────────────────────────────────────────────

test("warnings: −2 each on the handed-over draft, capped at −10", () => {
  const impact = allUnchangedBut(polybag, ["style-5pcs", "style-2pcs"]);
  const three = scoreCase(polybag, finished(polybag, [qtyBlock()], { impact, warnings: ["a", "b", "c"] }));
  assert.equal(three.warnings, 3);
  assert.equal(three.total, 100 - 3 * WARNING_PENALTY);
  const many = scoreCase(polybag, finished(polybag, [qtyBlock()], { impact, warnings: Array(9).fill("w") }));
  assert.equal(many.total, 100 - MAX_WARNING_PENALTY);
});
