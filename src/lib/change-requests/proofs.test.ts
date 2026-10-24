import { test, before, after } from "node:test";
import assert from "node:assert/strict";
// Type-only — erased at compile time, so nothing loads before the stub below.
import type { ImpactReviewStatus, ImpactRow } from "./types";
import type { ProofPick } from "./proofs";
// schema.ts is a pure leaf (zod only) — safe to load before the stub.
import { parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";

// proofs.ts is server-only (its loaders import db and the render pipeline),
// which constructs the db client at import time; a dummy DATABASE_URL lets it
// load. Nothing here queries: the picker is pure, and the render step is fed
// documents rendered from a synthetic definition (see render-output.test.ts).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let proofs: typeof import("./proofs");

before(async () => {
  proofs = await import("./proofs");
});

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────
const KEY = "layout:bogus-layout";

type BlockSpec = { id: string; lines: string[]; col?: number; row?: number; fontPt?: number };

function def(blocks: BlockSpec[], extraPages: { id: string; blocks: BlockSpec[] }[] = []): LayoutDef {
  const page = (id: string, bs: BlockSpec[]) => ({
    id,
    title: "",
    widthMm: 50,
    heightMm: 60,
    gridCols: 12,
    gridRows: 15,
    blocks: bs.map((b, i) => ({
      id: b.id,
      rect: { col: b.col ?? 0, row: b.row ?? i, colSpan: 12, rowSpan: 1 },
      fontPt: b.fontPt ?? 8,
      lines: b.lines,
    })),
  });
  return parseLayoutDef({ pages: [page("p1", blocks), ...extraPages.map((p) => page(p.id, p.blocks))] });
}

const BASE_BLOCKS: BlockSpec[] = [
  { id: "b-style", lines: ["{{styleNumber}}", "{{size}}"] },
  { id: "b-terms", lines: ['{{if deliveryTerm == "FOB"}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}'] },
];
const POLYBAG_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';
const BEFORE = def(BASE_BLOCKS);
// The design's reference change: a new polybag quantity block.
const AFTER = def([...BASE_BLOCKS, { id: "b-polybag", lines: [POLYBAG_LINE], row: 10 }]);

function row(
  styleId: string,
  opts: Partial<Omit<ImpactRow, "styleId">> & { suffix?: string; status?: ImpactReviewStatus } = {},
): ImpactRow {
  return {
    styleId,
    styleLabel: opts.styleLabel ?? `Style ${styleId}`,
    poNumber: opts.poNumber ?? "PO-0000",
    variantKey: opts.variantKey ?? (opts.suffix ? `${KEY}#${opts.suffix}` : KEY),
    changed: opts.changed ?? true,
    reviewStatus: opts.status ?? opts.reviewStatus ?? "PENDING_REVIEW",
    uploaded: opts.uploaded ?? false,
    emailed: opts.emailed ?? false,
    inFlight: opts.inFlight ?? false,
  };
}

const ids = (picks: ProofPick[]) => picks.map((p) => `${p.reason}:${p.styleId}${p.suffix ? `#${p.suffix}` : ""}`);

// ── changed ──────────────────────────────────────────────────────────────────

test("suffixPattern / docSignature: a split output's per-row files and its assortment file are different kinds", () => {
  assert.equal(proofs.suffixPattern(null), "single");
  assert.equal(proofs.suffixPattern("M-Black"), "per-row");
  assert.equal(proofs.suffixPattern("assort"), "assort");
  assert.equal(proofs.suffixPattern("assort-Navy-2"), "assort");
  assert.equal(proofs.docSignature(`${KEY}#S-Red`), proofs.docSignature(`${KEY}#XL-Blue-2`));
  assert.notEqual(proofs.docSignature(`${KEY}#S-Red`), proofs.docSignature(`${KEY}#assort`));
  assert.notEqual(proofs.docSignature(KEY), proofs.docSignature(`${KEY}#S-Red`));
});

test("changed: one pick per distinct kind of changed document, spread over review statuses", () => {
  const picks = proofs.pickRepresentatives({
    impact: {
      rows: [
        row("s1", { suffix: "S-Black" }),
        row("s1", { suffix: "M-Black" }),
        row("s1", { suffix: "assort" }),
        row("s2", { suffix: "S-Red", status: "APPROVED" }),
        row("s2", { suffix: "assort", status: "APPROVED" }),
      ],
    },
    before: BEFORE,
    after: AFTER,
  });
  // per-row kind: s1#S-Black (pending, first); assort kind: the APPROVED one
  // wins over another pending doc — variety of statuses.
  assert.deepEqual(ids(picks), ["changed:s1#S-Black", "changed:s2#assort"]);
  assert.match(picks[0].note, /changes · pending review/);
  assert.match(picks[1].note, /changes · approved/);
  assert.equal(picks[0].variantKey, `${KEY}#S-Black`, "the impact row's key, verbatim");
});

test("changed: most useful first — pending before approved before never generated, in-flight runs last", () => {
  const picks = proofs.pickRepresentatives({
    impact: {
      rows: [
        row("s-none", { status: "NONE" }),
        row("s-busy", { inFlight: true }),
        row("s-appr", { status: "APPROVED", emailed: true }),
        row("s-pend"),
      ],
    },
    before: BEFORE,
    after: AFTER,
  });
  // One kind (single document) → the lead, then one extra per unseen status.
  assert.deepEqual(ids(picks), ["changed:s-pend", "changed:s-appr", "changed:s-none"]);
  assert.match(picks[1].note, /approved, already emailed to the supplier/);
});

test("changed: the request's own style leads, even when another is more 'useful'", () => {
  const picks = proofs.pickRepresentatives({
    impact: { rows: [row("s1"), row("s2", { status: "APPROVED" })] },
    before: BEFORE,
    after: AFTER,
    focusStyleId: "s2",
  });
  assert.equal(picks[0].styleId, "s2");
  assert.match(picks[0].note, /^the request's style · changes · approved/);
});

// ── branch ───────────────────────────────────────────────────────────────────

test("changedConditionals: only the lines the draft touches; a restyled block counts whole", () => {
  // Added block → its conditional; the untouched terms block is not included.
  assert.deepEqual(
    proofs.changedConditionals(BEFORE, AFTER).map((c) => c.field),
    ["polybagQty"],
  );
  // A text edit elsewhere in a block with a conditional: only the edited line.
  const mixedBefore = def([{ id: "b1", lines: ['{{if deliveryTerm == "FOB"}}A{{endif}}', "{{size}}"] }]);
  const mixedAfter = def([{ id: "b1", lines: ['{{if deliveryTerm == "FOB"}}A{{endif}}', "{{size}} {{colour}}"] }]);
  assert.deepEqual(proofs.changedConditionals(mixedBefore, mixedAfter), []);
  // A font change re-renders the whole block, so its conditional counts.
  const bigger = def([{ id: "b1", lines: ['{{if deliveryTerm == "FOB"}}A{{endif}}', "{{size}}"], fontPt: 10 }]);
  assert.deepEqual(
    proofs.changedConditionals(mixedBefore, bigger).map((c) => c.field),
    ["deliveryTerm"],
  );
  // A removed line's conditional counts too (its branch disappears).
  const removed = def([{ id: "b1", lines: ["{{size}}"] }]);
  assert.deepEqual(
    proofs.changedConditionals(mixedBefore, removed).map((c) => c.field),
    ["deliveryTerm"],
  );
  // An added page counts with all its lines.
  const withPage = def([{ id: "b1", lines: ['{{if deliveryTerm == "FOB"}}A{{endif}}', "{{size}}"] }], [
    { id: "p2", blocks: [{ id: "b9", lines: ['{{if certificates includes "FSC"}}{{cert:fsc}}{{endif}}'] }] },
  ]);
  assert.deepEqual(proofs.branchFields(mixedBefore, withPage), ["certificates"]);
  // No change, nothing to test both ways.
  assert.deepEqual(proofs.changedConditionals(BEFORE, BEFORE), []);
});

test("branch: a style that shows the new conditional block and one where it is hidden", () => {
  const picks = proofs.pickRepresentatives({
    impact: {
      rows: [
        row("s1", { poNumber: "PO-0001" }),
        row("s2", { poNumber: "PO-0002" }),
        row("s3", { poNumber: "PO-0003", changed: false }),
        row("s4", { poNumber: "PO-0004", changed: false }),
      ],
    },
    before: BEFORE,
    after: AFTER,
    fieldValues: {
      s1: { polybagQty: "" },
      s2: { polybagQty: "5" },
      s3: { polybagQty: "12" },
      s4: { polybagQty: "" },
    },
  });
  // s2 is the changed style WITH a quantity → shows. The hidden side has no
  // changed candidate (s1 changed for another reason, so it still wins the
  // "changed first" rule and proves the block stays hidden there).
  const byStyle = new Map(picks.map((p) => [p.styleId, p]));
  assert.equal(byStyle.get("s2")?.reason, "branch");
  assert.equal(byStyle.get("s2")?.note, 'polybagQty = "5" → shows');
  assert.match(byStyle.get("s1")!.note, /changes · pending review; polybagQty empty → hidden$/);
  assert.equal(byStyle.get("s1")?.reason, "changed", "folded into the lead pick, no extra slot");
  assert.ok(picks.some((p) => p.reason === "control"));
});

test("branch: the hidden side may be an unchanged document — and folds into the control when it is one", () => {
  const picks = proofs.pickRepresentatives({
    impact: { rows: [row("s1"), row("s2"), row("s3", { changed: false })] },
    before: BEFORE,
    after: AFTER,
    fieldValues: { s1: { polybagQty: "5" }, s2: { polybagQty: "8" }, s3: { polybagQty: "" } },
  });
  assert.deepEqual(ids(picks), ["changed:s1", "control:s3"]);
  assert.equal(picks[0].note, 'changes · pending review; polybagQty = "5" → shows');
  assert.equal(picks[1].note, "no change, expected; polybagQty empty → hidden (no change)");
});

test("branch: a two-sided conditional names the side each style prints", () => {
  const before = def([{ id: "b1", lines: ["{{poNumber}}"] }]);
  const after = def([{ id: "b1", lines: ['{{if deliveryTerm == "FOB"}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}'] }]);
  const picks = proofs.pickRepresentatives({
    impact: { rows: [row("s-exw"), row("s-fob")] },
    before,
    after,
    fieldValues: { "s-exw": { deliveryTerm: "EXW" }, "s-fob": { deliveryTerm: "FOB" } },
  });
  const notes = picks.map((p) => p.note);
  assert.ok(notes.includes('deliveryTerm = "FOB" → prints {{customerOrderNo}}'), notes.join(" | "));
  assert.ok(notes.some((n) => n.endsWith('deliveryTerm = "EXW" → prints {{poNumber}}')), notes.join(" | "));
});

test("branch: no field values → no branch picks; only one side present → just that side", () => {
  const rows = [row("s1"), row("s2"), row("s3", { changed: false })];
  assert.ok(
    proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER }).every((p) => p.reason !== "branch"),
  );
  const oneSide = proofs.pickRepresentatives({
    impact: { rows },
    before: BEFORE,
    after: AFTER,
    fieldValues: { s1: { polybagQty: "5" }, s2: { polybagQty: "6" }, s3: { polybagQty: "7" } },
  });
  const branchNotes = oneSide.flatMap((p) => p.note.split("; ")).filter((n) => n.startsWith("polybagQty"));
  assert.deepEqual(branchNotes, ['polybagQty = "5" → shows']);
});

// ── control ──────────────────────────────────────────────────────────────────

test("control: prefers the lead's ProdSpec, falls back to its PO, and is labelled 'no change, expected'", () => {
  const rows = [
    row("lead", { poNumber: "PO-0001" }),
    row("other-spec", { poNumber: "PO-0002", changed: false }),
    row("same-po", { poNumber: "PO-0001", changed: false }),
    row("same-spec", { poNumber: "PO-0003", changed: false }),
  ];
  const withSpecs = proofs.pickRepresentatives({
    impact: { rows },
    before: BEFORE,
    after: AFTER,
    prodSpecIds: { lead: "spec-a", "other-spec": "spec-b", "same-po": "spec-b", "same-spec": "spec-a" },
  });
  const control = withSpecs.find((p) => p.reason === "control");
  assert.equal(control?.styleId, "same-spec");
  assert.equal(control?.note, "no change, expected");

  const byPo = proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER });
  assert.equal(byPo.find((p) => p.reason === "control")?.styleId, "same-po");
});

test("control: the lead style's own unchanged document is the best control", () => {
  const picks = proofs.pickRepresentatives({
    impact: {
      rows: [
        row("s2", { suffix: "S-Red", changed: false }),
        row("s1", { suffix: "assort" }),
        row("s1", { suffix: "M-Black", changed: false }),
      ],
    },
    before: BEFORE,
    after: AFTER,
  });
  assert.deepEqual(ids(picks), ["changed:s1#assort", "control:s1#M-Black"]);
});

test("control: none when every document changes; only a control when nothing changes", () => {
  const all = proofs.pickRepresentatives({ impact: { rows: [row("s1"), row("s2")] }, before: BEFORE, after: AFTER });
  assert.ok(all.every((p) => p.reason !== "control"));
  const none = proofs.pickRepresentatives({
    impact: { rows: [row("s1", { changed: false }), row("s2", { changed: false })] },
    before: BEFORE,
    after: AFTER,
  });
  assert.deepEqual(ids(none), ["control:s1"]);
});

// ── dedupe + cap ─────────────────────────────────────────────────────────────

test("dedupe: one pick per style + document, notes folded together", () => {
  const picks = proofs.pickRepresentatives({
    impact: { rows: [row("s1"), row("s1"), row("s2", { changed: false })] },
    before: BEFORE,
    after: AFTER,
    fieldValues: { s1: { polybagQty: "5" }, s2: { polybagQty: "" } },
  });
  const keys = picks.map((p) => `${p.styleId}#${p.suffix ?? ""}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(ids(picks), ["changed:s1", "control:s2"]);
});

test("cap: at most `max` picks; the lead and the control survive a tight cap", () => {
  const rows = [
    row("a", { suffix: "S-Black" }),
    row("b", { suffix: "assort", status: "APPROVED" }),
    row("c", { status: "REJECTED" }),
    row("d", { status: "NONE" }),
    row("e", { changed: false }),
    row("f"),
    row("g"),
  ];
  const fieldValues = { a: { polybagQty: "1" }, f: { polybagQty: "" }, g: { polybagQty: "2" } };
  const six = proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER, fieldValues });
  assert.ok(six.length <= proofs.DEFAULT_MAX_PICKS);
  assert.equal(six.length, 6);
  const two = proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER, fieldValues, max: 2 });
  assert.deepEqual(ids(two), ["changed:a#S-Black", "control:e"]);
  const one = proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER, fieldValues, max: 1 });
  assert.deepEqual(ids(one), ["changed:a#S-Black"]);
  assert.deepEqual(proofs.pickRepresentatives({ impact: { rows }, before: BEFORE, after: AFTER, max: 0 }), []);
  assert.deepEqual(proofs.pickRepresentatives({ impact: { rows: [] }, before: BEFORE, after: AFTER }), []);
});

test("order: changed, then branch, then control", () => {
  const picks = proofs.pickRepresentatives({
    impact: { rows: [row("s1"), row("s2"), row("s3", { changed: false }), row("s4")] },
    before: BEFORE,
    after: AFTER,
    fieldValues: { s1: { polybagQty: "" }, s2: { polybagQty: "" }, s4: { polybagQty: "3" } },
  });
  const order = picks.map((p) => p.reason);
  assert.deepEqual(order, [...order].sort((x, y) => ["changed", "branch", "control"].indexOf(x) - ["changed", "branch", "control"].indexOf(y)));
  assert.equal(order.at(-1), "control");
});

// ── route query ──────────────────────────────────────────────────────────────

test("parseProofQuery: styleId + side required, doc a small index, suffix optional", () => {
  const q = (s: string) => proofs.parseProofQuery(new URLSearchParams(s));
  assert.deepEqual(q("styleId=s1&side=before"), { ok: true, value: { styleId: "s1", side: "before", doc: 0 } });
  assert.deepEqual(q("styleId=s1&side=after&doc=2&suffix=M-Black"), {
    ok: true,
    value: { styleId: "s1", side: "after", doc: 2, suffix: "M-Black" },
  });
  for (const bad of ["side=before", "styleId=s1", "styleId=s1&side=sideways", "styleId=s1&side=after&doc=-1", "styleId=s1&side=after&doc=1.5", "styleId=s1&side=after&doc=x", "styleId=s1&side=after&doc=1000", "styleId=s1&side=after&suffix="]) {
    assert.equal(q(bad).ok, false, bad);
  }
});

// ── render step ──────────────────────────────────────────────────────────────

test("rasteriseProofDoc: a document index or suffix the output doesn't emit is ProofNotFoundError (no browser)", async () => {
  const docs = [{ suffix: "S", html: "<p>S</p>", widthMm: 50, heightMm: 30 }];
  await assert.rejects(proofs.rasteriseProofDoc(docs, { doc: 1 }), (e: unknown) => {
    assert.ok(e instanceof proofs.ProofNotFoundError);
    assert.equal(e.what, "doc");
    assert.equal(e.httpStatus, 404);
    return true;
  });
  await assert.rejects(proofs.rasteriseProofDoc(docs, { suffix: "XL" }), proofs.ProofNotFoundError);
  await assert.rejects(proofs.rasteriseProofDoc([], {}), proofs.ProofNotFoundError);
});

// Real Chromium: only where a browser is installed (PUPPETEER_EXECUTABLE_PATH).
const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;

test(
  "rasteriseProofDoc: renders a real PNG of the first page at the page box × scale",
  { skip: browserPath ? false : "PUPPETEER_EXECUTABLE_PATH not set" },
  async () => {
    const ro = await import("@/lib/output-layouts/render-output");
    const { buildSampleStyleData } = await import("@/lib/pdf/sample-data");
    const sticker = def([
      { id: "b1", lines: ["{{styleNumber}}", "{{size}}"] },
      { id: "b2", lines: [POLYBAG_LINE, "PROOF"], row: 10 },
    ]);
    const variant = ro.variantForDefinition(
      { id: "bogus-layout", name: "Proof sticker", docType: "STICKER", version: 1, isInfoArea: false, customLogo: null },
      sticker,
    );
    assert.ok(variant);
    const target = ro.assembleOutputTarget({
      styleId: "bogus-style",
      baseKey: KEY,
      variant,
      output: { variantKey: KEY, widthMm: 50, heightMm: 60, enabled: true },
      styleData: buildSampleStyleData(),
      fieldValues: new Map(),
      infoAreaSizes: new Map(),
    });
    const docs = await ro.renderOutputTarget(target, { lines: "none" });
    assert.ok(docs.length >= 1);

    const scale = 2;
    const proof = await proofs.rasteriseProofDoc(docs, { doc: 0, scale });
    assert.deepEqual([...proof.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    const width = proof.png.readUInt32BE(16);
    const height = proof.png.readUInt32BE(20);
    const px = (mm: number) => (mm * 96 * scale) / 25.4;
    assert.ok(Math.abs(width - px(50)) <= 2, `width ${width} ≈ ${px(50)}`);
    assert.ok(Math.abs(height - px(60)) <= 2, `height ${height} ≈ ${px(60)}`);
    assert.equal(proof.widthMm, 50);
    assert.equal(proof.heightMm, 60);
    assert.ok(proof.png.length > 1000, "not a blank stub");
  },
);

after(async () => {
  if (!browserPath) return;
  const { closeBrowser } = await import("@/lib/pdf/renderer");
  await closeBrowser();
});
