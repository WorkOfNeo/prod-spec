// The bench's fixture-backed tools: every production tool name is served,
// drafts stay in memory, hidden tokens behave as if they did not exist, the
// impact check tells a changed style from a control, and hand-offs are
// captured. No database (the offline stand-in is installed by the tools
// themselves — DATABASE_URL is unset on purpose) and no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AGENT_TOOL_NAMES, type AgentTool, type ToolContext, type ToolResult } from "../agent/contract";
import { toolDefinitions } from "../agent/loop";
import { loadBenchCase, type BenchCase } from "./case-schema";
import { fixtureImpact, fixtureTools, htmlTextSummary, inkHtml, outcomeFromState, type FixtureState } from "./fixture-tools";
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

const ctx: ToolContext = { requestId: "bench:test", outputId: "bench-output", userId: null, log: async () => {} };

function setup(c: BenchCase, images: "auto" | "off" = "off") {
  const { tools, state } = fixtureTools(c, { images });
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Like the loop: parse with the tool's schema, then run.
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
type Token = { key: string; value?: string; values?: Record<string, string> };
type TokenList = { count: number; tokens: Token[] };
type Rejected = { rejected: { reason: string }[] };
type Patch = Rejected & { draftId: string; applied: unknown[]; warnings: string[]; changes: string[] };
type Proof = { draftId?: string; images?: string; sides?: string[]; text: Record<string, string[]> };
type Block = { id: string; rect: unknown; lines: string[] };

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;

test("serves every production tool name, once, in contract order, with valid tool schemas", () => {
  const { tools } = setup(polybag);
  assert.deepEqual(
    tools.map((t) => t.name),
    [...AGENT_TOOL_NAMES],
  );
  const defs = toolDefinitions(tools);
  assert.equal(defs.length, AGENT_TOOL_NAMES.length);
  for (const d of defs) assert.equal((d.input_schema as { type: string }).type, "object", d.name);
  // The op union reaches the model as a schema it can follow.
  assert.match(JSON.stringify(defs.find((d) => d.name === "propose_patch")!.input_schema), /add_block/);
});

test("get_request, find_layouts and get_layout read the case", async () => {
  const { call } = setup(polybag);
  const req = content<{ output: { layoutId: string; representativeStyleId: string; issue: string } }>(await call("get_request"));
  assert.equal(req.output.layoutId, polybag.layout.id);
  assert.equal(req.output.representativeStyleId, "style-5pcs");
  assert.equal(req.output.issue, polybag.request.text);

  const layouts = content<{ layouts: { id: string }[] }>(await call("find_layouts", { docType: "polybag" }));
  assert.equal(layouts.layouts[0].id, polybag.layout.id);

  const layout = content<{ pages: { grid: unknown; blocks: Block[] }[] }>(await call("get_layout", { layoutId: polybag.layout.id }));
  const page = layout.pages[0];
  assert.deepEqual(page.grid, { cols: 50, rows: 60, cellWidthMm: 1, cellHeightMm: 1 });
  const price = page.blocks.find((b) => b.id === "b-price")!;
  assert.deepEqual(price.rect, { col: 2, row: 47, colSpan: 46, rowSpan: 12 });
  assert.deepEqual(price.lines, ["{{price}} €"]);

  const missing = await call("get_layout", { layoutId: "bogus-id" });
  assert.equal(missing.isError, true);
});

test("find_styles_by_value returns the full Monday value with column and style", async () => {
  const { call } = setup(polybag);
  const r = content<{ total: number; matches: { styleId: string; column: unknown; value: string }[] }>(
    await call("find_styles_by_value", { query: "solid polybag-" }),
  );
  assert.equal(r.total, 1);
  assert.equal(r.matches[0].styleId, "style-5pcs");
  assert.deepEqual(r.matches[0].column, { id: "trimsRaw", title: "Trims" });
  assert.match(r.matches[0].value, /^Price sticker, Solid polybag- 5 Pcs \/ Polybag, /);
});

test("list_tokens resolves through the production resolvers — and hides removed tokens", async () => {
  const { call } = setup(polybag);
  const qty = (r: ToolResult) => content<TokenList>(r).tokens.find((t) => t.key === "polybagQty");
  assert.equal(qty(await call("list_tokens", {}))?.value, "5");
  assert.equal(qty(await call("list_tokens", { styleId: "style-2pcs" }))?.value, "2");
  assert.equal(qty(await call("list_tokens", { styleId: "style-1pc" }))?.value, "");

  const g = setup(gap);
  const all = content<TokenList>(await g.call("list_tokens", {}));
  assert.equal(all.tokens.some((t) => t.key === "polybagQty"), false);
  assert.ok(all.tokens.some((t) => t.key === "price"));
  assert.equal(content<TokenList>(await g.call("list_tokens", { query: "polybag" })).count, 0);
  assert.equal(isOfflineDatabase((globalThis as { prisma?: unknown }).prisma), true, "ran on the offline stand-in");
});

test("list_tokens: per-language values for the style's languages", async () => {
  const { call } = setup(socks);
  const comp = content<TokenList>(await call("list_tokens", { query: "composition" })).tokens.find((t) => t.key === "composition");
  assert.equal(comp?.values?.fi, "80% Puuvilla, 17% Polyamidi, 3% Elastaani");
  assert.equal(comp?.values?.sv, "80% Bomull, 17% Polyamid, 3% Elastan");
});

test("propose_patch: applies ops to a draft in memory and reports the change", async () => {
  const { call, state } = setup(polybag);
  const r = await call("propose_patch", { layoutId: polybag.layout.id, ops: [QTY_OP], note: "qty above the price" });
  assert.equal(r.isError, undefined);
  const c = content<Patch>(r);
  assert.equal(c.draftId, "d1");
  assert.deepEqual(c.rejected, []);
  assert.deepEqual(c.warnings, []);
  assert.match(c.changes[0], /Added a block at col 7, row 42 \(27×4\)/);
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].definition.pages[0].blocks.at(-1)?.id, "b-add1");
  assert.equal(state.drafts[0].ops.length, 1);
  // The case's live layout is never touched.
  assert.equal(polybag.layout.definition.pages[0].blocks.length, 7);

  // Revising on top of the draft keeps the whole op history on the new one.
  const r2 = content<Patch>(
    await call("propose_patch", {
      layoutId: polybag.layout.id,
      parentDraftId: "d1",
      ops: [{ op: "set_block_props", page: 0, blockId: "b-add1", props: { fontPt: 8 } }],
    }),
  );
  assert.equal(r2.draftId, "d2");
  assert.equal(state.drafts[1].ops.length, 2);
  assert.equal(state.drafts[1].parentId, "d1");
});

test("propose_patch: rejected ops come back with reasons; nothing applied = no draft", async () => {
  const { call, state } = setup(polybag);
  const bad = await call("propose_patch", {
    layoutId: polybag.layout.id,
    ops: [{ op: "edit_line", page: 0, blockId: "b-price", line: 0, oldText: "{{price}}", newText: "{{price}} PCS" }],
  });
  assert.equal(bad.isError, true);
  assert.match(content<Rejected>(bad).rejected[0].reason, /is "\{\{price\}\} €", not "\{\{price\}\}"/);
  assert.equal(state.drafts.length, 0);

  const partial = content<Patch>(
    await call("propose_patch", {
      layoutId: polybag.layout.id,
      ops: [QTY_OP, { op: "remove_block", page: 0, blockId: "b-nope" }],
    }),
  );
  assert.equal(partial.draftId, "d1");
  assert.equal(partial.applied.length, 1);
  assert.match(partial.rejected[0].reason, /no block "b-nope"/);
});

test("propose_patch refuses a removed token like the publish gate refuses an unknown one", async () => {
  const { call, state } = setup(gap);
  const r = await call("propose_patch", { layoutId: gap.layout.id, ops: [QTY_OP] });
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
  const g = setup(gap);
  const ok = await g.call("declare_gap", gapInput);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(g.state.terminal, { name: "declare_gap", input: gapInput });

  const p = setup(polybag);
  const refused = await p.call("declare_gap", gapInput);
  assert.equal(refused.isError, true);
  assert.match(content<{ error: string }>(refused).error, /already exists/);
  assert.equal(p.state.terminal, undefined);
});

test("hand-offs: finish / ask_reviewer captured once; memories are not hand-offs", async () => {
  const { call, state } = setup(polybag);
  await call("propose_memory", { scope: "CUSTOMER", text: "Quantity goes above the price." });
  assert.equal(state.terminal, undefined);
  assert.deepEqual(state.memories, [{ scope: "CUSTOMER", text: "Quantity goes above the price." }]);

  await call("propose_patch", { layoutId: polybag.layout.id, ops: [QTY_OP] });
  const fin = content<{ draftId: string | null }>(await call("finish", { summary: "Added the quantity above the price." }));
  assert.equal(fin.draftId, "d1");
  await call("ask_reviewer", { question: "Too late to ask" });
  assert.deepEqual(state.terminal, { name: "finish", input: { summary: "Added the quantity above the price." } });

  const outcome = outcomeFromState(state as FixtureState);
  assert.equal(outcome.terminal?.name, "finish");
  assert.equal(outcome.drafts.length, 1);
  assert.deepEqual(outcome.warnings, []);

  const q = setup(polybag);
  await q.call("ask_reviewer", { question: "Above or beside the price?", options: ["above", "beside"] });
  assert.equal(q.state.terminal?.name, "ask_reviewer");
});

test("impact_list: the request's styles change, the control does not", async () => {
  const { call } = setup(polybag);
  await call("propose_patch", { layoutId: polybag.layout.id, ops: [QTY_OP] });
  type Impact = { changed: { styleId: string }[]; unchanged: unknown[]; counts: { changed: number; unchanged: number } };
  const r = content<Impact>(await call("impact_list"));
  assert.deepEqual(
    r.changed.map((x) => x.styleId),
    ["style-5pcs", "style-2pcs"],
  );
  assert.deepEqual(r.unchanged, [{ styleId: "style-1pc", styleLabel: polybag.styles[2].label }]);
  assert.equal(r.counts.changed, 2);
  assert.equal(r.counts.unchanged, 1);

  assert.equal((await setup(polybag).call("impact_list")).isError, true, "no draft yet");
});

test("fixtureImpact: a guarded block leaves the control alone, an unguarded one does not", async () => {
  const block = (lines: string[]) => ({
    op: "add_block" as const,
    page: 0,
    block: { rect: { col: 2, row: 35, colSpan: 36, rowSpan: 11 }, fontPt: 5, lines },
  });
  const { call, state } = setup(socks);
  await call("propose_patch", {
    layoutId: socks.layout.id,
    ops: [block(['{{if productGroup == "Socks"}}{{composition:fi}}{{endif}}', '{{if productGroup == "Socks"}}{{washSymbols}}{{endif}}'])],
  });
  await call("propose_patch", { layoutId: socks.layout.id, ops: [block(["{{composition:fi}}", "{{washSymbols}}"])] });

  const changed = async (i: number) =>
    Object.fromEntries((await fixtureImpact(socks, state.drafts[i].definition)).rows.map((r) => [r.styleId, r.changed]));
  assert.deepEqual(await changed(0), { "style-socks": true, "style-wool-socks": true, "style-tee": false });
  assert.deepEqual(await changed(1), { "style-socks": true, "style-wool-socks": true, "style-tee": true });
});

test("inkHtml drops blocks that print nothing, keeps framed or inverted ones", () => {
  const id = (h: string) => h;
  const empty = '<div class="ol-block ol-rect" style="left: 1mm; "><div class="ol-line">&nbsp;</div></div>';
  const framed = '<div class="ol-block ol-rect" style="left: 1mm; border: 0.3mm solid #000; "><div class="ol-line">&nbsp;</div></div>';
  const inverted = '<div class="ol-block ol-rect ol-binvert" style="left: 1mm; "><div class="ol-line">&nbsp;</div></div>';
  const inked = '<div class="ol-block ol-rect" style="left: 1mm; "><div class="ol-line">5 PCS</div></div>';
  assert.equal(inkHtml(`<p>${empty}</p>`, id), "<p></p>");
  for (const keep of [framed, inverted, inked]) assert.equal(inkHtml(keep, id), keep);
});

test("render_proof without pictures: a text reading of page 1, before and after", async () => {
  const { call } = setup(polybag, "off");
  await call("propose_patch", { layoutId: polybag.layout.id, ops: [QTY_OP] });
  const r = content<Proof>(await call("render_proof", { styleId: "style-5pcs" }));
  assert.match(r.images ?? "", /^unavailable/);
  assert.equal(r.draftId, "d1");
  const after = r.text.after.join("\n");
  assert.match(after, /at 7\.00,42\.00 mm \(27\.00×4\.00 mm\): 5 PCS/);
  assert.match(after, /barcode \[2000000100012\]/);
  assert.match(after, /more pages not shown/);
  assert.doesNotMatch(r.text.before.join("\n"), /PCS/);

  const control = content<Proof>(await call("render_proof", { styleId: "style-1pc", side: "after" }));
  assert.doesNotMatch(control.text.after.join("\n"), /PCS/);

  const noDraft = content<Proof>(await setup(polybag).call("render_proof", { styleId: "style-5pcs" }));
  assert.deepEqual(Object.keys(noDraft.text), ["before"]);
});

test("htmlTextSummary names graphics and decodes entities", () => {
  const html =
    '<body><div class="ol-page ol-page-0"><div class="ol-block ol-rect" style="left: 2.00mm; top: 3.00mm; width: 10.00mm; height: 4.00mm; ">' +
    '<div class="ol-line"><span class="ol-symbols"><img src="x" alt="wash30" /><span class="missing" title="t">iron_no</span></span></div>' +
    '<div class="ol-line">A &amp; B &lt;x&gt;</div></div></div></body>';
  assert.deepEqual(htmlTextSummary(html), ["at 2.00,3.00 mm (10.00×4.00 mm): symbols [wash30][missing: iron_no] / A & B <x>"]);
});

test(
  "render_proof with a browser: before and after pictures of the first page",
  { skip: browserPath ? false : "PUPPETEER_EXECUTABLE_PATH not set" },
  async () => {
    const { call } = setup(polybag, "auto");
    await call("propose_patch", { layoutId: polybag.layout.id, ops: [QTY_OP] });
    const r = await call("render_proof", { styleId: "style-5pcs" });
    assert.deepEqual(content<Proof>(r).sides, ["before", "after"]);
    assert.equal(r.images?.length, 2);
    for (const img of r.images ?? []) {
      const png = Buffer.from(img.base64, "base64");
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
    assert.match(r.images![1].caption ?? "", /^after · .* · draft d1$/);
  },
);

after(async () => {
  if (!browserPath) return;
  const { closeBrowser } = await import("@/lib/pdf/renderer");
  await closeBrowser();
});
