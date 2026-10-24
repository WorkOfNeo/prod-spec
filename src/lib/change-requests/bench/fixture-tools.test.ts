// The bench's fixture-backed tools: the production tool definitions with only
// run() swapped, drafts kept in memory, hidden tokens behaving as if they did
// not exist, the impact check telling a changed style from a control, and
// hand-offs captured. No database (the offline stand-in is installed by the
// tools themselves — DATABASE_URL is unset on purpose) and no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AGENT_TOOL_NAMES, type AgentTool, type ToolContext, type ToolResult } from "../agent/contract";
import { toolDefinitions } from "../agent/loop";
import { loadBenchCase, type BenchCase } from "./case-schema";
import { fixtureImpact, fixtureTools, htmlTextSummary, outcomeFromState } from "./fixture-tools";
import { isOfflineDatabase } from "./offline-db";

delete process.env.DATABASE_URL;

const CASES = resolve(__dirname, "../../../../scripts/cr-bench/cases");
const polybag = loadBenchCase(`${CASES}/polybag-qty.json`).case;
const gap = loadBenchCase(`${CASES}/polybag-qty-gap.json`).case;
const socks = loadBenchCase(`${CASES}/socks-composition.json`).case;

const QTY_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';
const QTY_OP = {
  op: "add_block",
  page: 0,
  block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, fontPt: 7, bold: true, align: "center", lines: [QTY_LINE] },
};
const patch = (c: BenchCase, ops: unknown[], note = "Quantity above the price") => ({ layoutId: c.layout.id, ops, note });

const ctx: ToolContext = { requestId: "bench:test", outputId: "bench-output", userId: null, log: async () => {} };

async function setup(c: BenchCase, images: "auto" | "off" = "off") {
  const { tools, state } = await fixtureTools(c, { images });
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Like the loop: parse with the tool's (production) schema, then run.
  const call = async (name: string, input: unknown = {}): Promise<ToolResult> => {
    const tool = byName.get(name as AgentTool["name"]);
    assert.ok(tool, `no tool ${name}`);
    const parsed = tool.input.safeParse(input);
    assert.ok(parsed.success, `${name} input: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
    return tool.run(parsed.data, ctx);
  };
  return { tools, state, call };
}

// Tool results are plain JSON; each test reads the shape it needs.
const content = <T>(r: ToolResult): T => r.content as T;
type Rejected = { rejected: { reason: string }[] };
type Patch = Rejected & { revisionId: string; number: number; base: string; parentRevisionId: string | null; applied: unknown[]; warnings: string[]; changes: string[] };
type Proof = { images: { side: string; caption: string; suffix: string | null }[]; picturesUnavailable?: string; text?: Record<string, string[]> };
type Tokens = {
  count: number;
  tokens: { key: string }[];
  resolved: { languages: string[]; values: { token: string; value: string }[]; empty: string[] } | null;
};
const value = (t: Tokens, token: string) => t.resolved?.values.find((v) => v.token === token)?.value;

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;

test("the production tool definitions, in contract order, with only run() swapped", async () => {
  const { tools } = await setup(polybag);
  const production = await import("../agent/tools");
  assert.deepEqual(
    tools.map((t) => t.name),
    [...AGENT_TOOL_NAMES],
  );
  for (const t of tools) {
    const prod = production.toolByName(t.name)!;
    assert.equal(t.description, prod.description, t.name);
    assert.equal(t.input, prod.input, `${t.name}: the production zod schema itself`);
    assert.notEqual(t.run, prod.run, `${t.name}: a fixture implementation`);
  }
  assert.deepEqual(toolDefinitions(tools), toolDefinitions(production.AGENT_TOOLS), "the model sees identical tool definitions");
  assert.equal(isOfflineDatabase((globalThis as { prisma?: unknown }).prisma), true, "loaded on the offline stand-in");
});

test("get_request, find_layouts and get_layout read the case in production's shapes", async () => {
  const { call } = await setup(polybag);
  const req = content<{ output: { layoutId: string; styleId: string; text: string; currentRevisionId: string | null }; request: { poNumber: string } }>(
    await call("get_request"),
  );
  assert.equal(req.output.layoutId, polybag.layout.id);
  assert.equal(req.output.styleId, "style-5pcs");
  assert.equal(req.output.text, polybag.request.text);
  assert.equal(req.output.currentRevisionId, null);
  assert.equal(req.request.poNumber, "PO-0001");

  const layouts = content<{ thisOutputLayoutId: string; layouts: { id: string; thisOutput: boolean; docType: string }[] }>(
    await call("find_layouts", { docType: "STICKER" }),
  );
  assert.equal(layouts.thisOutputLayoutId, polybag.layout.id);
  assert.deepEqual(layouts.layouts.map((l) => [l.id, l.thisOutput, l.docType]), [[polybag.layout.id, true, "STICKER"]]);

  type Layout = { showing: string; openDraft: unknown; pages: { grid: unknown; cellMm: unknown; blocks: { id: string; rect: unknown; mm: unknown; lines: string[] }[] }[] };
  const layout = content<Layout>(await call("get_layout", { layoutId: polybag.layout.id }));
  assert.equal(layout.showing, "live");
  assert.equal(layout.openDraft, null);
  assert.deepEqual(layout.pages[0].grid, { cols: 50, rows: 60 });
  assert.deepEqual(layout.pages[0].cellMm, { width: 1, height: 1 });
  const price = layout.pages[0].blocks.find((b) => b.id === "b-price")!;
  assert.deepEqual(price.rect, { col: 2, row: 47, colSpan: 46, rowSpan: 12 });
  assert.deepEqual(price.mm, { x: 2, y: 47, width: 46, height: 12 });
  assert.deepEqual(price.lines, ["{{price}} €"]);

  assert.equal((await call("get_layout", { layoutId: "bogus-id" })).isError, true);
});

test("find_styles_by_value: production's per-column summary over the case's styles", async () => {
  const { call } = await setup(polybag);
  type Found = {
    columns: { columnId: string; title: string; mappedAs: string[]; styles: number; values: { text: string; count: number }[]; examples: { styleId: string }[] }[];
  };
  const r = content<Found>(await call("find_styles_by_value", { text: "solid polybag-" }));
  assert.equal(r.columns.length, 1);
  const trims = r.columns[0];
  assert.equal(trims.columnId, "dropdown4__1", "the default Trims column id");
  assert.equal(trims.title, "Trims");
  assert.deepEqual(trims.mappedAs, ["trims"]);
  assert.equal(trims.styles, 1);
  assert.match(trims.values[0].text, /^Price sticker, Solid polybag- 5 Pcs \/ Polybag, /);
  assert.deepEqual(trims.examples.map((e) => e.styleId), ["style-5pcs"]);

  const hinted = content<Found>(await call("find_styles_by_value", { text: "pcs", columnHint: "trims" }));
  assert.equal(hinted.columns[0].styles, 2);
  const elsewhere = content<Found>(await call("find_styles_by_value", { text: "pcs", customerId: "bogus-customer" }));
  assert.deepEqual(elsewhere.columns, []);
});

test("list_tokens: production's catalogue and resolved values — and removed tokens are gone", async () => {
  const { call } = await setup(polybag);
  assert.equal(value(content<Tokens>(await call("list_tokens", {})), "{{polybagQty}}"), "5");
  assert.equal(value(content<Tokens>(await call("list_tokens", { styleId: "style-2pcs" })), "{{polybagQty}}"), "2");
  const one = content<Tokens>(await call("list_tokens", { styleId: "style-1pc", query: "polybag" }));
  assert.equal(value(one, "{{polybagQty}}"), undefined);
  assert.deepEqual(one.resolved?.empty, ["polybagQty"]);

  const g = await setup(gap);
  const all = content<Tokens>(await g.call("list_tokens", {}));
  assert.equal(all.tokens.some((t) => t.key === "polybagQty"), false);
  assert.ok(all.tokens.some((t) => t.key === "price"));
  assert.equal(all.resolved?.empty.includes("polybagQty"), false);
  assert.equal(content<Tokens>(await g.call("list_tokens", { query: "polybag" })).count, 0);
});

test("list_tokens resolves per-language variables in en + the style's first output language", async () => {
  const { call } = await setup(socks);
  const t = content<Tokens>(await call("list_tokens", { query: "composition" }));
  assert.deepEqual(t.resolved?.languages, ["en", "fi"]);
  assert.equal(value(t, "{{composition:fi}}"), "80% Puuvilla, 17% Polyamidi, 3% Elastaani");
  assert.equal(value(t, "{{composition:en}}"), "80% Cotton, 17% Polyamide, 3% Elastane");
});

test("propose_patch: a revision in memory; the next patch refines the current draft", async () => {
  const { call, state } = await setup(polybag);
  const r = await call("propose_patch", patch(polybag, [QTY_OP]));
  assert.equal(r.isError, undefined);
  const c = content<Patch>(r);
  assert.equal(c.revisionId, "bench-rev-1");
  assert.equal(c.base, "live");
  assert.deepEqual(c.rejected, []);
  assert.deepEqual(c.warnings, []);
  assert.match(c.changes[0], /Added a block at col 7, row 42 \(27×4\)/);
  assert.equal(state.drafts[0].definition.pages[0].blocks.at(-1)?.id, "b-add1");
  // The case's live layout is never touched.
  assert.equal(polybag.layout.definition.pages[0].blocks.length, 7);

  const r2 = content<Patch>(
    await call("propose_patch", patch(polybag, [{ op: "set_block_props", page: 0, blockId: "b-add1", props: { fontPt: 8 } }])),
  );
  assert.equal(r2.revisionId, "bench-rev-2");
  assert.equal(r2.base, "draft");
  assert.equal(r2.parentRevisionId, "bench-rev-1");
  assert.equal(state.drafts[1].ops.length, 2);

  const req = content<{ output: { currentRevisionId: string } }>(await call("get_request"));
  assert.equal(req.output.currentRevisionId, "bench-rev-2");
  const layout = content<{ showing: string; draftChanges: string[] }>(await call("get_layout", { layoutId: polybag.layout.id }));
  assert.equal(layout.showing, "draft");
  assert.ok(layout.draftChanges.some((ch) => ch.includes("Font 7 → 8") || ch.includes("Added a block")));
  assert.equal(content<{ showing: string }>(await call("get_layout", { layoutId: polybag.layout.id, live: true })).showing, "live");
});

test("propose_patch: rejected ops come back with reasons; nothing applied = no draft; other layouts refused", async () => {
  const { call, state } = await setup(polybag);
  const bad = await call(
    "propose_patch",
    patch(polybag, [{ op: "edit_line", page: 0, blockId: "b-price", line: 0, oldText: "{{price}}", newText: "{{price}} PCS" }]),
  );
  assert.equal(bad.isError, true);
  assert.match(content<Rejected>(bad).rejected[0].reason, /is "\{\{price\}\} €", not "\{\{price\}\}"/);
  assert.equal(state.drafts.length, 0);

  const partial = content<Patch>(await call("propose_patch", patch(polybag, [QTY_OP, { op: "remove_block", page: 0, blockId: "b-nope" }])));
  assert.equal(partial.revisionId, "bench-rev-1");
  assert.equal(partial.applied.length, 1);
  assert.match(partial.rejected[0].reason, /no block "b-nope"/);

  const other = await call("propose_patch", { layoutId: "bogus-layout", ops: [QTY_OP], note: "x" });
  assert.equal(other.isError, true);
  assert.match(content<{ error: string }>(other).error, /only that layout can be drafted/);
});

test("propose_patch refuses a removed token like the publish gate refuses an unknown one", async () => {
  const { call, state } = await setup(gap);
  const r = await call("propose_patch", patch(gap, [QTY_OP]));
  assert.equal(r.isError, true);
  assert.match(content<Rejected>(r).rejected[0].reason, /unknown variable \{\{polybagQty\}\}/);
  assert.equal(state.drafts.length, 0);
});

test("declare_gap: accepted for a removed token, refused for one that exists", async () => {
  const gapInput = {
    tokenKey: "polybagQty",
    label: "Pieces per solid polybag",
    source: { board: "Styles", column: "Trims", examples: [{ value: "Solid polybag- 5 Pcs / Polybag", count: 1 }] },
    rule: "The count in the solid polybag trim entry when above one, else empty.",
    cases: [{ input: "Solid polybag- 5 Pcs / Polybag", output: "5" }],
  };
  const g = await setup(gap);
  const ok = await g.call("declare_gap", gapInput);
  assert.equal(ok.isError, undefined);
  assert.equal(content<{ status: string }>(ok).status, "NEEDS_CODE");
  assert.deepEqual(g.state.terminal, { name: "declare_gap", input: gapInput });

  const p = await setup(polybag);
  const refused = await p.call("declare_gap", gapInput);
  assert.equal(refused.isError, true);
  assert.match(content<{ error: string }>(refused).error, /already exists \("Pieces per solid polybag/);
  assert.equal(p.state.terminal, undefined);
});

test("hand-offs: finish / ask_reviewer captured once; memories are not hand-offs", async () => {
  const { call, state } = await setup(polybag);
  const mem = content<{ scopeRef: string }>(
    await call("propose_memory", { scope: "CUSTOMER", text: "Quantity goes above the price.", sourceKind: "AGENT_FINDING" }),
  );
  assert.equal(mem.scopeRef, "bench-customer", "defaults to the request's customer, as in production");
  assert.equal(state.terminal, undefined);
  assert.equal(state.memories.length, 1);

  await call("propose_patch", patch(polybag, [QTY_OP]));
  await call("finish", { summary: "Added the quantity above the price." });
  await call("ask_reviewer", { question: "Too late to ask", to: "admin" });
  assert.deepEqual(state.terminal, { name: "finish", input: { summary: "Added the quantity above the price." } });

  const outcome = outcomeFromState(state);
  assert.equal(outcome.terminal?.name, "finish");
  assert.equal(outcome.drafts.length, 1);
  assert.deepEqual(outcome.warnings, []);

  const q = await setup(polybag);
  const asked = content<{ status: string }>(await q.call("ask_reviewer", { question: "Above or beside the price?", to: "requester" }));
  assert.equal(asked.status, "NEEDS_INFO");
  assert.equal(q.state.terminal?.name, "ask_reviewer");
});

test("impact_list: per-document counts; the request's styles change, the control does not", async () => {
  const { call } = await setup(polybag);
  await call("propose_patch", patch(polybag, [QTY_OP]));
  type Impact = {
    counts: { styles: number; docs: number; changed: number; unchanged: number };
    changed: { styleId: string; variantKey: string }[];
    unchangedControls: { styleId: string }[];
  };
  const r = content<Impact>(await call("impact_list", { revisionId: "bench-rev-1" }));
  // 4 + 3 + 2 sizes, one document each; the 1-piece style's 2 stay the same.
  assert.deepEqual(r.counts, { ...r.counts, styles: 3, docs: 9, changed: 7, unchanged: 2 });
  assert.deepEqual([...new Set(r.changed.map((x) => x.styleId))], ["style-5pcs", "style-2pcs"]);
  assert.ok(r.changed.every((x) => x.variantKey.startsWith(`layout:${polybag.layout.id}#`)));
  assert.deepEqual(r.unchangedControls.map((x) => x.styleId), ["style-1pc"]);

  assert.equal((await call("impact_list", { revisionId: "bench-rev-9" })).isError, true);
});

test("fixtureImpact: a guarded block leaves the control alone, an unguarded one does not", async () => {
  const block = (lines: string[]) => ({
    op: "add_block" as const,
    page: 0,
    block: { rect: { col: 2, row: 35, colSpan: 36, rowSpan: 11 }, fontPt: 5, lines },
  });
  const { call, state } = await setup(socks);
  await call("propose_patch", patch(socks, [block(['{{if productGroup == "Socks"}}{{composition:fi}}{{endif}}', '{{if productGroup == "Socks"}}{{washSymbols}}{{endif}}'])]));
  const guarded = Object.fromEntries((await fixtureImpact(socks, state.drafts[0].definition)).rows.map((r) => [r.styleId, r.changed]));
  assert.deepEqual(guarded, { "style-socks": true, "style-wool-socks": true, "style-tee": false });

  const unguarded = (await setup(socks));
  await unguarded.call("propose_patch", patch(socks, [block(["{{composition:fi}}", "{{washSymbols}}"])]));
  const all = Object.fromEntries(
    (await fixtureImpact(socks, unguarded.state.drafts[0].definition)).rows.map((r) => [r.styleId, r.changed]),
  );
  assert.deepEqual(all, { "style-socks": true, "style-wool-socks": true, "style-tee": true });
});

test("render_proof without pictures: production's captions plus a text reading of each side", async () => {
  const { call } = await setup(polybag, "off");
  await call("propose_patch", patch(polybag, [QTY_OP]));
  const r = content<Proof>(await call("render_proof", { revisionId: "bench-rev-1", styleId: "style-5pcs" }));
  assert.deepEqual(r.images.map((i) => i.side), ["before", "after"]);
  assert.match(r.images[1].caption, /^after · Kids tee 5-pack .* · 98104 · 50×60 mm$/);
  assert.match(r.picturesUnavailable ?? "", /switched off/);
  const after = r.text!.after.join("\n");
  assert.match(after, /at 7\.00,42\.00 mm \(27\.00×4\.00 mm\): 5 PCS/);
  assert.match(after, /barcode \[2000000100012\]/);
  assert.doesNotMatch(r.text!.before.join("\n"), /PCS/);

  const control = content<Proof>(await call("render_proof", { revisionId: "bench-rev-1", styleId: "style-1pc", side: "after" }));
  assert.doesNotMatch(control.text!.after.join("\n"), /PCS/);

  const second = content<Proof>(await call("render_proof", { revisionId: "bench-rev-1", styleId: "style-5pcs", side: "after", suffix: "110116" }));
  assert.equal(second.images[0].suffix, "110116");
  assert.match(second.text!.after.join("\n"), /110\/116/);

  for (const bad of [
    { revisionId: "bench-rev-9", styleId: "style-5pcs" },
    { revisionId: "bench-rev-1", styleId: "bogus-style" },
    { revisionId: "bench-rev-1", styleId: "style-5pcs", suffix: "nope" },
  ]) {
    const res = await call("render_proof", bad);
    assert.equal(res.isError, true, JSON.stringify(bad));
    assert.match(content<{ error: string }>(res).error, /^Could not render the before proof: /);
  }
});

test("htmlTextSummary names graphics and decodes entities", () => {
  const html =
    '<body><div class="ol-page ol-page-0"><div class="ol-block ol-rect" style="left: 2.00mm; top: 3.00mm; width: 10.00mm; height: 4.00mm; ">' +
    '<div class="ol-line"><span class="ol-symbols"><img src="x" alt="wash30" /><span class="missing" title="t">iron_no</span></span></div>' +
    '<div class="ol-line">A &amp; B &lt;x&gt;</div></div></div></body>';
  assert.deepEqual(htmlTextSummary(html), ["at 2.00,3.00 mm (10.00×4.00 mm): symbols [wash30][missing: iron_no] / A & B <x>"]);
});

test(
  "render_proof with a browser: before and after pictures through rasteriseProofDoc",
  { skip: browserPath ? false : "PUPPETEER_EXECUTABLE_PATH not set" },
  async () => {
    const { call } = await setup(polybag, "auto");
    await call("propose_patch", patch(polybag, [QTY_OP]));
    const r = await call("render_proof", { revisionId: "bench-rev-1", styleId: "style-5pcs" });
    assert.equal(content<Proof>(r).picturesUnavailable, undefined);
    assert.equal(r.images?.length, 2);
    for (const img of r.images ?? []) {
      const png = Buffer.from(img.base64, "base64");
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
    assert.match(r.images![1].caption ?? "", /^after · .* · 98104 · 50×60 mm$/);
  },
);

after(async () => {
  if (!browserPath) return;
  const { closeBrowser } = await import("@/lib/pdf/renderer");
  await closeBrowser();
});
