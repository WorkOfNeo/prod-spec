// The change-request agent's tools (src/lib/change-requests/agent/tools.ts)
// and the DB half of the gap check (declareGap's writes, resumeAwaitingCode):
// each tool's happy path and its main refusal.
//
// The REAL tool implementations, the real op language (ops.ts), schema and
// token catalogue run against mocked edges: a stub `db`, the store, layout
// revisions, proofs, impact, the style render context and the email dispatch
// are module mocks that record what they were asked. Nothing touches a
// database, a browser or the network. Fixtures are synthetic.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolResult } from "@/lib/change-requests/agent/contract";
import type { StyleData } from "@/lib/pdf/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const REQUEST_ID = "bogus-req";
const OUTPUT_ID = "bogus-out";
const OTHER_OUTPUT_ID = "bogus-out-2";
const LAYOUT_ID = "bogus-layout";
const OTHER_LAYOUT_ID = "bogus-layout-2";
const STYLE_ID = "bogus-style";
const CUSTOMER_ID = "bogus-cust";
const QTY_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';

function stickerDef(colourLine = "COLOUR: {{colourName}}") {
  return {
    pages: [
      {
        id: "p1",
        title: "Sticker",
        widthMm: 50,
        heightMm: 60,
        gridCols: 50,
        gridRows: 60,
        blocks: [
          { id: "b-style", rect: { col: 2, row: 2, colSpan: 46, rowSpan: 6 }, fontPt: 9, lines: ["{{styleNumber}}"] },
          { id: "b-colour", rect: { col: 2, row: 48, colSpan: 46, rowSpan: 7 }, fontPt: 6.5, lines: [colourLine] },
        ],
      },
    ],
  };
}

type Row = Record<string, unknown>;

let request: Row;
let output: Row & { request: Row };
let otherOutput: Row;
let layouts: Row[];
let revisions: Row[];
let messages: Row[];
let attachments: Row[];
let specs: Row[];
let styleCounts: Row[];
let ghostColumns: Row[];
let waitingOutputs: Row[];
let admins: { email: string }[];
let queryRaw: (q: { sql: string; values: unknown[] }) => Promise<unknown[]>;

function resetFixtures() {
  request = {
    id: REQUEST_ID,
    number: 42,
    title: "Polybag sticker needs the pack quantity",
    status: "WORKING",
    message: "Please print the pieces per polybag on the sticker.",
    source: "ADMIN",
    createdById: "admin-1",
    customerId: CUSTOMER_ID,
    poNumber: "PO-0000",
    styleId: STYLE_ID,
  };
  output = {
    id: OUTPUT_ID,
    requestId: REQUEST_ID,
    position: 0,
    label: "Solid polybag sticker",
    variantKey: `layout:${LAYOUT_ID}`,
    layoutId: LAYOUT_ID,
    styleId: STYLE_ID,
    text: "Add QTY: n PCS above the colour line.",
    status: "WORKING",
    currentRevisionId: null,
    draftCount: 0,
    awaitingToken: null,
    request,
  };
  otherOutput = { ...output, id: OTHER_OUTPUT_ID, position: 1, label: "Carton marking", request: undefined };
  layouts = [
    {
      id: LAYOUT_ID,
      name: "Bogus polybag sticker",
      docType: "STICKER",
      status: "PUBLISHED",
      version: 3,
      definition: stickerDef(),
    },
    {
      id: OTHER_LAYOUT_ID,
      name: "Bogus carton marking",
      docType: "CARTON_MARKING",
      status: "PUBLISHED",
      version: 1,
      definition: stickerDef(),
    },
  ];
  revisions = [];
  messages = [
    { id: "m1", outputId: null, authorKind: "USER", kind: "message", body: "Request-wide note", revisionId: null, createdAt: new Date("2026-10-24T08:00:00Z") },
    { id: "m2", outputId: OTHER_OUTPUT_ID, authorKind: "USER", kind: "message", body: "About the carton", revisionId: null, createdAt: new Date("2026-10-24T08:01:00Z") },
    { id: "m3", outputId: OUTPUT_ID, authorKind: "AGENT", kind: "message", body: "Draft ready", revisionId: "rev-old", createdAt: new Date("2026-10-24T08:02:00Z") },
  ];
  attachments = [
    { id: "a1", outputId: OUTPUT_ID, fileName: "sticker.png", mimeType: "image/png", byteSize: 10 },
    { id: "a2", outputId: OTHER_OUTPUT_ID, fileName: "carton.png", mimeType: "image/png", byteSize: 10 },
  ];
  specs = [
    {
      id: "bogus-spec",
      name: "Bogus spec A",
      outputs: [
        { variantKey: `layout:${LAYOUT_ID}`, widthMm: 50, heightMm: 60, enabled: true },
        { variantKey: `layout:${OTHER_LAYOUT_ID}`, widthMm: 150, heightMm: 75, enabled: true },
      ],
    },
    {
      id: "bogus-spec-2",
      name: "Bogus spec B",
      outputs: [
        { variantKey: `layout:${OTHER_LAYOUT_ID}#assort`, widthMm: 150, heightMm: 75, enabled: true },
        { variantKey: `layout:${LAYOUT_ID}`, widthMm: 50, heightMm: 60, enabled: false },
      ],
    },
  ];
  styleCounts = [
    { prodSpecId: "bogus-spec", _count: { _all: 4 } },
    { prodSpecId: "bogus-spec-2", _count: { _all: 10 } },
  ];
  ghostColumns = [
    { mondayColumnId: "dropdown4__1", title: "Trims (other board)", type: "dropdown", board: { mondayBoardId: "9999", name: "Other", label: null } },
    { mondayColumnId: "dropdown4__1", title: "Trims", type: "dropdown", board: { mondayBoardId: "1111", name: "Pre-Order board", label: "Pre-Order" } },
  ];
  waitingOutputs = [];
  admins = [{ email: "admin@example.com" }, { email: "admin2@example.com" }];
  queryRaw = async () => [];
}

// ── Recorders ───────────────────────────────────────────────────────────────

const calls: Record<string, unknown[]> = {};
function record(name: string, arg: unknown) {
  (calls[name] ??= []).push(arg);
}

// Honour a Prisma `select` so results have exactly the asked-for shape.
function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

// Every model the tools don't use explicitly answers empty (translations,
// care labels, symbols… read by the token augments).
const explicitDb: Record<string, unknown> = {
  customer: {
    findUnique: async (args: { where: { id: string }; select?: Row }) =>
      args.where.id === CUSTOMER_ID ? pick({ id: CUSTOMER_ID, name: "Bogus Customer", config: {} }, args.select) : null,
  },
  style: {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === STYLE_ID ? { id: STYLE_ID, name: "Bogus Tee", poNumber: "PO-0000" } : null,
    groupBy: async (args: unknown) => {
      record("style.groupBy", args);
      return styleCounts;
    },
  },
  prodSpec: {
    findMany: async (args: unknown) => {
      record("prodSpec.findMany", args);
      return specs;
    },
  },
  outputLayout: {
    findUnique: async (args: { where: { id: string } }) => layouts.find((l) => l.id === args.where.id) ?? null,
    findMany: async (args: { where: { id?: { in: string[] }; name?: { contains: string } } }) => {
      if (args.where.id) return layouts.filter((l) => args.where.id!.in.includes(l.id as string));
      const q = args.where.name?.contains.toLowerCase() ?? "";
      return layouts.filter((l) => (l.name as string).toLowerCase().includes(q));
    },
  },
  changeRequestOutput: {
    update: async (args: unknown) => {
      record("changeRequestOutput.update", args);
      return {};
    },
    findMany: async (args: unknown) => {
      record("changeRequestOutput.findMany", args);
      if (waitingOutputs === null) throw Object.assign(new Error("missing table"), { code: "P2021" });
      return waitingOutputs;
    },
  },
  mondayColumnConfig: { findUnique: async () => ({ columnMapping: {}, requiredFields: [{ id: "text_bogus9", label: "Bogus required" }] }) },
  mondayGhostColumn: {
    findMany: async (args: { where: { mondayColumnId?: { in: string[] }; OR?: unknown } }) => {
      record("mondayGhostColumn.findMany", args);
      if (args.where.mondayColumnId) return ghostColumns.filter((g) => args.where.mondayColumnId!.in.includes(g.mondayColumnId as string));
      return [{ mondayColumnId: "dropdown4__1" }];
    },
  },
  user: {
    findMany: async (args: unknown) => {
      record("user.findMany", args);
      return admins;
    },
  },
  $queryRaw: async (q: { sql: string; values: unknown[] }) => {
    record("$queryRaw", q);
    return queryRaw(q);
  },
};
const fakeDb = new Proxy(explicitDb, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return { findMany: async () => [], findUnique: async () => null, findFirst: async () => null };
  },
});

// Store
let requestDetailImpl: (id: string) => Promise<unknown>;
const store = {
  getRequestDetail: async (id: string) => requestDetailImpl(id),
  getOutputWithRequest: async (id: string) => {
    if (id === OUTPUT_ID) return output;
    return null;
  },
  appendMessage: async (input: Row) => {
    record("appendMessage", input);
    return { id: `msg-${(calls.appendMessage ?? []).length}`, ...input };
  },
  setOutputStatus: async (outputId: string, status: string, patch: Row = {}) => {
    record("setOutputStatus", { outputId, status, patch });
    return { id: outputId, requestId: REQUEST_ID };
  },
  createProposedMemory: async (input: Row) => {
    record("createProposedMemory", input);
    return { id: "mem-1", ...input };
  },
  logStep: async (input: Row) => {
    record("logStep", input);
    return input;
  },
  rollUpStatus: () => "WORKING",
  rollUpRequestStatus: async () => "WORKING",
  getAttachmentImages: async () => [],
};

// Revisions
let revisionCounter = 0;
const revisionsMock = {
  getRevision: async (id: string) => revisions.find((r) => r.id === id) ?? null,
  createDraft: async (input: Row) => {
    record("createDraft", input);
    const row = { id: `rev-new-${++revisionCounter}`, number: 10 + revisionCounter, status: "DRAFT", ...input };
    revisions.push(row);
    return row;
  },
  reviseDraft: async (parentId: string, input: Row) => {
    record("reviseDraft", { parentId, input });
    const parent = revisions.find((r) => r.id === parentId)!;
    const row = { id: `rev-new-${++revisionCounter}`, number: 10 + revisionCounter, status: "DRAFT", layoutId: parent.layoutId, parentRevisionId: parentId, ...input };
    revisions.push(row);
    return row;
  },
};

// Proofs / impact
let renderProofImpl: (input: Row) => Promise<unknown>;
let impactImpl: (revisionId: string) => Promise<unknown>;

// Email
let dispatchImpl: (input: Row) => Promise<unknown>;

let sampleStyle: () => StyleData;
let tools: typeof import("@/lib/change-requests/agent/tools");
let gap: typeof import("@/lib/change-requests/gap");
let AGENT_TOOL_NAMES: readonly string[];

before(async () => {
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/change-requests/store", { namedExports: store });
  mock.module("@/lib/output-layouts/revisions", { namedExports: revisionsMock });
  mock.module("@/lib/change-requests/proofs", {
    namedExports: {
      PROOF_SIDES: ["before", "after"],
      renderProof: async (input: Row) => {
        record("renderProof", input);
        return renderProofImpl(input);
      },
    },
  });
  mock.module("@/lib/change-requests/impact", {
    namedExports: {
      impactForRevision: async (id: string) => {
        record("impactForRevision", id);
        return impactImpl(id);
      },
    },
  });
  mock.module("@/lib/styles/render-context", {
    namedExports: {
      loadStyleRenderContext: async (id: string) =>
        id === STYLE_ID
          ? { styleId: id, poSeq: null, styleData: sampleStyle(), prodSpec: null, outputs: [], readiness: [] }
          : null,
    },
  });
  mock.module("@/lib/email/dispatch", {
    namedExports: {
      dispatchEmail: async (input: Row) => {
        record("dispatchEmail", input);
        return dispatchImpl(input);
      },
    },
  });

  const { buildSampleStyleData } = await import("@/lib/pdf/sample-data");
  sampleStyle = () => ({
    ...buildSampleStyleData(),
    styleNumber: "BOGUS-001",
    trimsRaw: "Solid polybag- 5 Pcs / Polybag",
    outputLanguages: ["da"],
  });
  tools = await import("@/lib/change-requests/agent/tools");
  gap = await import("@/lib/change-requests/gap");
  ({ AGENT_TOOL_NAMES } = await import("@/lib/change-requests/agent/contract"));
});

let logs: { kind: string; summary: string; detail?: Record<string, unknown> }[];

beforeEach(() => {
  resetFixtures();
  for (const k of Object.keys(calls)) delete calls[k];
  logs = [];
  revisionCounter = 0;
  renderProofImpl = async (input) => ({
    png: Buffer.from(`png-${input.side}`),
    widthMm: 50,
    heightMm: 60,
    suffix: null,
    doc: 0,
  });
  impactImpl = async () => ({ rows: [], counts: {}, errors: [] });
  requestDetailImpl = async (id) =>
    id === REQUEST_ID ? { ...request, outputs: [output, otherOutput], attachments, messages, steps: [] } : null;
  dispatchImpl = async (input) => ({ status: "SIMULATED", to: String(input.to), emailLogId: "log-1" });
  delete process.env.CHANGE_REQUEST_DEVELOPER_EMAIL;
  process.env.PROD_SPEC_BASE_URL = "https://prod-spec.example.com/";
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    requestId: REQUEST_ID,
    outputId: OUTPUT_ID,
    userId: "admin-1",
    log: async (step) => {
      logs.push(step);
    },
    ...over,
  };
}

function tool(name: string): AgentTool {
  const t = tools.toolByName(name);
  assert.ok(t, `tool ${name}`);
  return t;
}

// Parse the input as the loop does, then run.
async function run(name: string, input: unknown, c: ToolContext = ctx()): Promise<ToolResult> {
  const t = tool(name);
  const parsed = t.input.safeParse(input);
  assert.ok(parsed.success, `input for ${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
  return t.run(parsed.data, c);
}

const content = (r: ToolResult) => r.content as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── The list ────────────────────────────────────────────────────────────────

test("AGENT_TOOLS implements exactly AGENT_TOOL_NAMES, in order, each with a description and an object schema", () => {
  assert.deepEqual(
    tools.AGENT_TOOLS.map((t) => t.name),
    [...AGENT_TOOL_NAMES],
  );
  for (const t of tools.AGENT_TOOLS) {
    assert.ok(t.description.length > 80, `${t.name} has a real description`);
    const schema = z.toJSONSchema(t.input) as { type?: string };
    assert.equal(schema.type, "object", `${t.name} input is an object`);
    assert.equal(tools.toolByName(t.name), t);
  }
  assert.equal(tools.toolByName("publish_layout"), undefined);
});

test("an unexpected throw inside a tool comes back as an error result", async () => {
  requestDetailImpl = async () => {
    throw new Error("connection reset");
  };
  const res = await run("get_request", {});
  assert.equal(res.isError, true);
  assert.equal(content(res).error, "connection reset");
});

// ── get_request ─────────────────────────────────────────────────────────────

test("get_request: the request, this output, its thread and attachment names", async () => {
  const res = await run("get_request", {});
  assert.equal(res.isError, undefined);
  const c = content(res);
  assert.equal(c.request.ref, "R-0042");
  assert.equal(c.request.message, request.message);
  assert.equal(c.request.poNumber, "PO-0000");
  assert.deepEqual(c.request.customer, { id: CUSTOMER_ID, name: "Bogus Customer" });
  assert.equal(c.output.id, OUTPUT_ID);
  assert.equal(c.output.layoutId, LAYOUT_ID);
  assert.equal(c.output.text, output.text);
  assert.deepEqual(c.style, { id: STYLE_ID, label: "Bogus Tee", poNumber: "PO-0000" });
  // This output's messages and request-wide ones, not the other output's.
  assert.deepEqual(
    c.thread.map((m: { body: string }) => m.body),
    ["Request-wide note", "Draft ready"],
  );
  assert.equal(c.thread[1].revisionId, "rev-old");
  assert.deepEqual(c.attachments, [{ fileName: "sticker.png", outputId: OUTPUT_ID }]);
  assert.deepEqual(c.otherOutputs, [{ label: "Carton marking", status: "WORKING" }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "read");
});

test("get_request: refuses without a request, or with an output from another request", async () => {
  const none = await run("get_request", {}, ctx({ requestId: "" }));
  assert.equal(none.isError, true);
  const missing = await run("get_request", {}, ctx({ requestId: "bogus-missing" }));
  assert.equal(missing.isError, true);
  assert.match(content(missing).error, /not found/);
  const wrongOutput = await run("get_request", {}, ctx({ outputId: "bogus-foreign" }));
  assert.equal(wrongOutput.isError, true);
  assert.match(content(wrongOutput).error, /not part of request R-0042/);
});

// ── find_styles_by_value ────────────────────────────────────────────────────

test("find_styles_by_value: full values grouped per column with titles, boards, counts and examples", async () => {
  queryRaw = async (q) => {
    if (q.sql.includes("row_number()")) {
      return [
        { styleId: "s1", label: "Tee A", poNumber: "PO-0000", customer: "Bogus Customer", mondayBoardId: "1111", columnId: "dropdown4__1", text: "Solid polybag- 5 Pcs / Polybag, Carton Marking" },
        { styleId: "s2", label: "Tee B", poNumber: "PO-0001", customer: "Bogus Customer", mondayBoardId: "1111", columnId: "dropdown4__1", text: "Solid polybag- 5 Pcs / Polybag" },
        { styleId: "s3", label: "Tee C", poNumber: null, customer: null, mondayBoardId: "1111", columnId: "text_bogus9", text: "5 pcs per pack" },
      ];
    }
    return [
      { columnId: "dropdown4__1", text: "Solid polybag- 5 Pcs / Polybag", n: 30, total: 41, distinctValues: 2 },
      { columnId: "dropdown4__1", text: "Solid polybag- 5 Pcs / Polybag, Carton Marking", n: 11, total: 41, distinctValues: 2 },
      { columnId: "text_bogus9", text: "5 pcs per pack", n: 2, total: 2, distinctValues: 1 },
    ];
  };
  const res = await run("find_styles_by_value", { text: "5 pcs" });
  assert.equal(res.isError, undefined);
  const cols = content(res).columns;
  assert.equal(cols.length, 2);
  assert.equal(cols[0].columnId, "dropdown4__1");
  // The mirror's title on the board the examples live on wins.
  assert.equal(cols[0].title, "Trims");
  assert.deepEqual(cols[0].board, { id: "1111", name: "Pre-Order" });
  assert.deepEqual(cols[0].mappedAs, ["trims"]);
  assert.equal(cols[0].styles, 41);
  assert.equal(cols[0].distinctValues, 2);
  assert.deepEqual(cols[0].values[0], { text: "Solid polybag- 5 Pcs / Polybag", count: 30 });
  assert.equal(cols[0].examples.length, 2);
  assert.equal(cols[0].examples[0].text, "Solid polybag- 5 Pcs / Polybag, Carton Marking");
  // The shared config's label stands in when the mirror has no title.
  assert.equal(cols[1].title, "Bogus required");

  // Parameterised: two queries, the text as a bound ILIKE pattern.
  const queries = calls.$queryRaw as { sql: string; values: unknown[] }[];
  assert.equal(queries.length, 2);
  for (const q of queries) {
    assert.match(q.sql, /ILIKE \?/);
    assert.ok(q.values.includes("%5 pcs%"));
    assert.match(q.sql, /"archivedAt" IS NULL/);
    assert.match(q.sql, /"deletedAt" IS NULL/);
  }
  assert.equal(logs[0].kind, "read");
});

test("find_styles_by_value: wildcards are literal, columnHint and customerId narrow the query, nothing found says so", async () => {
  const res = await run("find_styles_by_value", { text: "100%_x", columnHint: "trims", customerId: CUSTOMER_ID });
  assert.equal(res.isError, undefined);
  const c = content(res);
  assert.deepEqual(c.columns, []);
  assert.match(c.note, /No active style carries this text/);
  // The hint resolved to itself, the mapped field's column and the mirror's match.
  assert.deepEqual(c.columnIds, ["trims", "dropdown4__1"]);
  const q = (calls.$queryRaw as { sql: string; values: unknown[] }[])[0];
  assert.ok(q.values.includes("%100\\%\\_x%"));
  assert.ok(q.values.includes(CUSTOMER_ID));
  assert.match(q.sql, /"customerId" = \?/);
  assert.match(q.sql, /cv->>'id' = ANY\(\?::text\[\]\)/);

  // Too short to search.
  assert.equal(tool("find_styles_by_value").input.safeParse({ text: "x" }).success, false);
});

// ── find_layouts ────────────────────────────────────────────────────────────

test("find_layouts: layouts printing for the request's customer, this output's first, with usage", async () => {
  const res = await run("find_layouts", {});
  const c = content(res);
  assert.equal(c.scope.customerId, CUSTOMER_ID);
  assert.equal(c.scope.fromRequest, true);
  assert.deepEqual((calls["prodSpec.findMany"][0] as { where: unknown }).where, { customerId: CUSTOMER_ID });
  assert.equal(c.thisOutputLayoutId, LAYOUT_ID);
  assert.deepEqual(
    c.layouts.map((l: { id: string }) => l.id),
    [LAYOUT_ID, OTHER_LAYOUT_ID],
  );
  const own = c.layouts[0];
  assert.equal(own.thisOutput, true);
  // Only the enabled output counts: spec A prints it, spec B has it disabled.
  assert.deepEqual(own.usage, { prodSpecs: 1, styles: 4, prodSpecNames: ["Bogus spec A"] });
  // A split key (#assort) still counts for its layout.
  assert.deepEqual(c.layouts[1].usage, { prodSpecs: 2, styles: 14, prodSpecNames: ["Bogus spec A", "Bogus spec B"] });
});

test("find_layouts: docType narrows the list but keeps this output's layout", async () => {
  const res = await run("find_layouts", { docType: "carton_marking", prodSpecId: "bogus-spec" });
  const c = content(res);
  assert.deepEqual((calls["prodSpec.findMany"][0] as { where: unknown }).where, { id: "bogus-spec" });
  assert.deepEqual(
    c.layouts.map((l: { id: string; thisOutput: boolean }) => [l.id, l.thisOutput]),
    [
      [LAYOUT_ID, true],
      [OTHER_LAYOUT_ID, false],
    ],
  );
  const none = await run("find_layouts", { docType: "HANGTAG" }, ctx({ outputId: null }));
  assert.deepEqual(content(none).layouts, []);
});

// ── get_layout ──────────────────────────────────────────────────────────────

test("get_layout: the live definition with ids, rects in cells and mm, 0-based addressing", async () => {
  const res = await run("get_layout", { layoutId: LAYOUT_ID });
  const c = content(res);
  assert.equal(c.showing, "live");
  assert.equal(c.openDraft, null);
  assert.deepEqual(c.layout, { id: LAYOUT_ID, name: "Bogus polybag sticker", docType: "STICKER", status: "PUBLISHED", version: 3 });
  const page = c.pages[0];
  assert.equal(page.page, 0);
  assert.deepEqual(page.grid, { cols: 50, rows: 60 });
  assert.deepEqual(page.cellMm, { width: 1, height: 1 });
  const colour = page.blocks.find((b: { id: string }) => b.id === "b-colour");
  assert.deepEqual(colour.rect, { col: 2, row: 48, colSpan: 46, rowSpan: 7 });
  assert.deepEqual(colour.mm, { x: 2, y: 48, width: 46, height: 7 });
  assert.equal(colour.fontPt, 6.5);
  assert.deepEqual(colour.lines, ["COLOUR: {{colourName}}"]);
  assert.equal(c.settings.repeatBy, "none");
});

test("get_layout: with an open draft shows the draft and what it changes (live: true shows live); unknown layout refused", async () => {
  revisions.push({
    id: "rev-draft",
    layoutId: LAYOUT_ID,
    number: 5,
    status: "DRAFT",
    note: "Bigger colour",
    definition: stickerDef("COLOUR: {{colourName}} / {{colourCode}}"),
  });
  output.currentRevisionId = "rev-draft";
  const draft = content(await run("get_layout", { layoutId: LAYOUT_ID }));
  assert.equal(draft.showing, "draft");
  assert.deepEqual(draft.openDraft, { revisionId: "rev-draft", number: 5, note: "Bigger colour" });
  assert.equal(draft.draftChanges.length, 1);
  assert.match(draft.pages[0].blocks[1].lines[0], /colourCode/);

  const live = content(await run("get_layout", { layoutId: LAYOUT_ID, live: true }));
  assert.equal(live.showing, "live");
  assert.doesNotMatch(live.pages[0].blocks[1].lines[0], /colourCode/);

  const missing = await run("get_layout", { layoutId: "bogus-missing" });
  assert.equal(missing.isError, true);
  assert.match(content(missing).error, /not found/);
});

// ── list_tokens ─────────────────────────────────────────────────────────────

test("list_tokens: catalogue filtered by query, resolved for this output's style (en + the ProdSpec's first language)", async () => {
  const res = await run("list_tokens", { query: "polybag" });
  const c = content(res);
  assert.deepEqual(
    c.tokens.map((t: { key: string }) => t.key),
    ["polybagQty"],
  );
  assert.equal(c.resolved.styleId, STYLE_ID);
  assert.deepEqual(c.resolved.languages, ["en", "da"]);
  assert.deepEqual(c.resolved.values, [{ token: "{{polybagQty}}", key: "polybagQty", value: "5" }]);
  assert.ok(Array.isArray(c.syntax));

  const all = content(await run("list_tokens", { styleId: STYLE_ID }));
  const value = (token: string) => all.resolved.values.find((v: { token: string }) => v.token === token)?.value;
  assert.equal(value("{{styleNumber}}"), "BOGUS-001");
  assert.equal(value("{{composition:en}}"), "100% Organic Cotton");
  assert.equal(value("{{composition:da}}"), "100% Økologisk Bomuld");
  assert.ok(all.resolved.empty.includes("cartonNo"));
});

test("list_tokens: an unknown style says so instead of failing", async () => {
  const c = content(await run("list_tokens", { styleId: "bogus-missing", query: "style" }));
  assert.equal(c.resolved, null);
  assert.match(c.resolvedError, /not found/);
  assert.ok(c.tokens.length > 0);
});

// ── propose_patch ───────────────────────────────────────────────────────────

const ADD_QTY = {
  op: "add_block",
  page: 0,
  block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: [QTY_LINE], fontPt: 7, bold: true },
};

test("propose_patch: ops on the live layout → an AGENT draft on this output, made current", async () => {
  const res = await run("propose_patch", { layoutId: LAYOUT_ID, ops: [ADD_QTY], note: "Add the polybag quantity" });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const c = content(res);
  assert.equal(c.base, "live");
  assert.equal(c.applied, 1);
  assert.deepEqual(c.rejected, []);
  assert.equal(c.parentRevisionId, null);
  assert.equal(c.changes.length, 1);
  assert.match(c.changes[0], /Added a block at col 7, row 42 \(27×4\)/);

  assert.equal(calls.createDraft.length, 1);
  const draft = calls.createDraft[0] as Row & { definition: { pages: { blocks: { lines: string[] }[] }[] } };
  assert.equal(draft.layoutId, LAYOUT_ID);
  assert.equal(draft.authorKind, "AGENT");
  assert.equal(draft.changeRequestOutputId, OUTPUT_ID);
  assert.equal(draft.note, "Add the polybag quantity");
  assert.equal((draft.ops as unknown[]).length, 1);
  assert.ok(draft.definition.pages[0].blocks.some((b) => b.lines.includes(QTY_LINE)));
  assert.equal(calls.reviseDraft, undefined);

  assert.deepEqual(calls["changeRequestOutput.update"], [
    { where: { id: OUTPUT_ID }, data: { currentRevisionId: c.revisionId } },
  ]);
  assert.equal(logs[0].kind, "draft");
});

test("propose_patch: refines this output's open draft (parent = current draft, ops checked against it)", async () => {
  revisions.push({
    id: "rev-draft",
    layoutId: LAYOUT_ID,
    number: 5,
    status: "DRAFT",
    definition: stickerDef("COLOUR: {{colourName}} / {{colourCode}}"),
  });
  output.currentRevisionId = "rev-draft";
  const res = await run("propose_patch", {
    layoutId: LAYOUT_ID,
    ops: [
      {
        op: "edit_line",
        page: 0,
        blockId: "b-colour",
        line: 0,
        // Only the draft has this text; the live layout would reject the op.
        oldText: "COLOUR: {{colourName}} / {{colourCode}}",
        newText: "COLOUR: {{colourCode}}",
      },
    ],
    note: "Code only",
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const c = content(res);
  assert.equal(c.base, "draft");
  assert.equal(c.parentRevisionId, "rev-draft");
  assert.equal(calls.createDraft, undefined);
  const revised = calls.reviseDraft[0] as { parentId: string; input: Row };
  assert.equal(revised.parentId, "rev-draft");
  assert.equal(revised.input.changeRequestOutputId, OUTPUT_ID);
  assert.equal(revised.input.authorKind, "AGENT");
});

test("propose_patch: nothing applied → error with the reasons and no draft", async () => {
  const res = await run("propose_patch", {
    layoutId: LAYOUT_ID,
    ops: [
      { op: "edit_line", page: 0, blockId: "b-colour", line: 0, oldText: "WRONG TEXT", newText: "X" },
      { op: "remove_block", page: 0, blockId: "bogus-block" },
    ],
    note: "Bad ops",
  });
  assert.equal(res.isError, true);
  const c = content(res);
  assert.match(c.error, /No op could be applied/);
  assert.equal(c.rejected.length, 2);
  assert.ok(c.rejected.every((r: { reason: string }) => r.reason.length > 0));
  assert.equal(calls.createDraft, undefined);
  assert.equal(calls["changeRequestOutput.update"], undefined);
});

test("propose_patch: refuses without an output, on another layout, or on a coded-template output", async () => {
  const input = { layoutId: LAYOUT_ID, ops: [ADD_QTY], note: "n" };
  const noOutput = await run("propose_patch", input, ctx({ outputId: null }));
  assert.equal(noOutput.isError, true);
  assert.match(content(noOutput).error, /needs the output/);

  const other = await run("propose_patch", { ...input, layoutId: OTHER_LAYOUT_ID });
  assert.equal(other.isError, true);
  assert.match(content(other).error, /only that layout can be drafted/);
  assert.equal(content(other).layoutId, LAYOUT_ID);

  output.layoutId = null;
  output.variantKey = "care-label-01";
  const coded = await run("propose_patch", input);
  assert.equal(coded.isError, true);
  assert.match(content(coded).error, /coded template/);
  assert.equal(calls.createDraft, undefined);
});

test("propose_patch: an output with no layout yet is pinned to the drafted one", async () => {
  output.layoutId = null;
  output.variantKey = null;
  const res = await run("propose_patch", { layoutId: OTHER_LAYOUT_ID, ops: [ADD_QTY], note: "n" });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual(calls["changeRequestOutput.update"], [
    {
      where: { id: OUTPUT_ID },
      data: { currentRevisionId: content(res).revisionId, layoutId: OTHER_LAYOUT_ID, variantKey: `layout:${OTHER_LAYOUT_ID}` },
    },
  ]);
});

// ── render_proof ────────────────────────────────────────────────────────────

test("render_proof: both sides by default, as PNG images with captions and size", async () => {
  const res = await run("render_proof", { revisionId: "rev-1", styleId: STYLE_ID });
  assert.equal(res.isError, undefined);
  assert.equal(res.images?.length, 2);
  assert.deepEqual(
    res.images!.map((i) => [i.mediaType, Buffer.from(i.base64, "base64").toString(), i.caption]),
    [
      ["image/png", "png-before", "before · Bogus Tee · doc 1 · 50×60 mm"],
      ["image/png", "png-after", "after · Bogus Tee · doc 1 · 50×60 mm"],
    ],
  );
  assert.deepEqual(
    (calls.renderProof as Row[]).map((r) => [r.revisionId, r.styleId, r.side]),
    [
      ["rev-1", STYLE_ID, "before"],
      ["rev-1", STYLE_ID, "after"],
    ],
  );
  assert.equal(content(res).images.length, 2);
  assert.equal(logs[0].kind, "proof");

  const after = await run("render_proof", { revisionId: "rev-1", styleId: STYLE_ID, side: "after", suffix: "M" });
  assert.equal(after.images?.length, 1);
  assert.equal((calls.renderProof as Row[]).at(-1)?.suffix, "M");
});

test("render_proof: a render failure is an error result", async () => {
  renderProofImpl = async () => {
    throw new Error("This output has no document \"XL\"");
  };
  const res = await run("render_proof", { revisionId: "rev-1", styleId: STYLE_ID, suffix: "XL" });
  assert.equal(res.isError, true);
  assert.match(content(res).error, /Could not render the before proof: This output has no document "XL"/);
  assert.equal(res.images, undefined);
});

// ── impact_list ─────────────────────────────────────────────────────────────

test("impact_list: counts, up to 30 changed documents, unchanged controls, errors", async () => {
  const row = (i: number, changed: boolean) => ({
    styleId: `s${i}`,
    styleLabel: `Style ${i}`,
    poNumber: "PO-0000",
    variantKey: `layout:${LAYOUT_ID}`,
    changed,
    reviewStatus: i === 0 ? "APPROVED" : "PENDING_REVIEW",
    uploaded: i === 0,
    emailed: false,
    inFlight: false,
  });
  const rows = [...Array.from({ length: 35 }, (_, i) => row(i, true)), row(100, false), row(101, false)];
  const counts = { styles: 37, docs: 37, changed: 35, unchanged: 2, changedByStatus: {}, approvedChanged: 1, deliveredChanged: 1 };
  impactImpl = async () => ({ rows, counts, errors: [{ styleId: "s-err", message: "boom" }], durationMs: 1200 });

  const res = await run("impact_list", { revisionId: "rev-1" });
  assert.equal(res.isError, undefined);
  const c = content(res);
  assert.deepEqual(c.counts, counts);
  assert.equal(c.changed.length, 30);
  assert.equal(c.changedNotShown, 5);
  assert.deepEqual(c.changed[0], {
    styleId: "s0",
    style: "Style 0",
    poNumber: "PO-0000",
    variantKey: `layout:${LAYOUT_ID}`,
    reviewStatus: "APPROVED",
    uploaded: true,
  });
  assert.deepEqual(
    c.unchangedControls.map((r: { styleId: string }) => r.styleId),
    ["s100", "s101"],
  );
  assert.deepEqual(c.errors, [{ styleId: "s-err", message: "boom" }]);
  assert.equal(logs[0].kind, "impact");
});

test("impact_list: too many styles / unknown revision is an error result", async () => {
  impactImpl = async () => {
    throw new Error("This layout prints on more than 400 styles, too many to compare in one go.");
  };
  const res = await run("impact_list", { revisionId: "rev-1" });
  assert.equal(res.isError, true);
  assert.match(content(res).error, /more than 400 styles/);
});

// ── declare_gap ─────────────────────────────────────────────────────────────

const GAP = {
  tokenKey: "bogusPackQty",
  label: "Pieces per bogus pack",
  source: { board: "Pre-Order", column: "Bogus Packing", examples: [{ value: "Bogus pack - 3 Pcs", count: 12 }] },
  rule: "Pieces per pack when more than one.",
  cases: [
    { input: "Bogus pack - 3 Pcs", output: "3" },
    { input: "Single bogus pack", output: "" },
  ],
};

test("declare_gap: NEEDS_CODE with the awaited token and the spec, a thread note, the developer email", async () => {
  const res = await run("declare_gap", GAP);
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const c = content(res);
  assert.equal(c.status, "NEEDS_CODE");
  assert.equal(c.awaitingToken, "bogusPackQty");
  assert.equal(c.buildPromptUrl, `https://prod-spec.example.com/requests/${REQUEST_ID}/build-prompt?output=${OUTPUT_ID}`);
  assert.deepEqual(c.email, { status: "SIMULATED", recipients: 2 });

  const status = calls.setOutputStatus[0] as { outputId: string; status: string; patch: { awaitingToken: string; codeSpec: { buildPrompt: string; tokenKey: string } } };
  assert.equal(status.outputId, OUTPUT_ID);
  assert.equal(status.status, "NEEDS_CODE");
  assert.equal(status.patch.awaitingToken, "bogusPackQty");
  assert.equal(status.patch.codeSpec.tokenKey, "bogusPackQty");
  assert.match(status.patch.codeSpec.buildPrompt, /R-0042 \(Solid polybag sticker\) on the layout "Bogus polybag sticker"/);

  const msg = calls.appendMessage[0] as Row;
  assert.equal(msg.authorKind, "AGENT");
  assert.equal(msg.kind, "status");
  assert.match(String(msg.body), /\{\{bogusPackQty\}\}/);

  const mail = calls.dispatchEmail[0] as Row;
  assert.equal(mail.type, "CHANGE_REQUEST_NEEDS_CODE");
  assert.deepEqual(mail.to, ["admin@example.com", "admin2@example.com"]);
  assert.equal(mail.subject, "Variable needed: {{bogusPackQty}} · blocks R-0042 (Solid polybag sticker)");
  assert.ok(String(mail.html).includes(`/requests/${REQUEST_ID}/build-prompt?output=${OUTPUT_ID}`));
  assert.deepEqual(
    logs.map((l) => l.kind),
    ["gap", "email"],
  );
});

test("declare_gap: CHANGE_REQUEST_DEVELOPER_EMAIL wins over the admins; a failing email doesn't undo the handoff", async () => {
  process.env.CHANGE_REQUEST_DEVELOPER_EMAIL = "dev@example.com, dev2@example.com";
  dispatchImpl = async () => {
    throw new Error("smtp down");
  };
  const res = await run("declare_gap", GAP);
  assert.equal(res.isError, undefined);
  assert.deepEqual((calls.dispatchEmail[0] as Row).to, ["dev@example.com", "dev2@example.com"]);
  assert.equal(calls["user.findMany"], undefined);
  assert.deepEqual(content(res).email, { status: "ERROR", error: "smtp down" });
  assert.equal((calls.setOutputStatus[0] as { status: string }).status, "NEEDS_CODE");
  assert.deepEqual(
    logs.map((l) => l.kind),
    ["gap", "error"],
  );
});

test("declare_gap: an existing token is refused and nothing moves", async () => {
  const res = await run("declare_gap", { ...GAP, tokenKey: "polybagQty" });
  assert.equal(res.isError, true);
  assert.match(content(res).error, /already exists/);
  assert.equal(calls.setOutputStatus, undefined);
  assert.equal(calls.appendMessage, undefined);
  assert.equal(calls.dispatchEmail, undefined);
  // A key that isn't a token name never reaches the tool.
  assert.equal(tool("declare_gap").input.safeParse({ ...GAP, tokenKey: "bogus pack" }).success, false);
});

// ── ask_reviewer ────────────────────────────────────────────────────────────

test("ask_reviewer: a question in the thread; requester → NEEDS_INFO, admin → IN_REVIEW", async () => {
  const toRequester = await run("ask_reviewer", { question: "Above or below the colour line?", to: "requester" });
  assert.equal(toRequester.isError, undefined);
  assert.equal(content(toRequester).status, "NEEDS_INFO");
  const msg = calls.appendMessage[0] as Row;
  assert.equal(msg.kind, "question");
  assert.equal(msg.authorKind, "AGENT");
  assert.equal(msg.outputId, OUTPUT_ID);
  assert.deepEqual(msg.meta, { to: "requester" });
  assert.deepEqual(calls.setOutputStatus[0], { outputId: OUTPUT_ID, status: "NEEDS_INFO", patch: {} });

  await run("ask_reviewer", { question: "Which of the two layouts?", to: "admin" });
  assert.equal((calls.setOutputStatus[1] as { status: string }).status, "IN_REVIEW");
  assert.equal(logs.at(-1)?.kind, "question");
});

test("ask_reviewer: refuses without an output", async () => {
  const res = await run("ask_reviewer", { question: "Q?", to: "admin" }, ctx({ outputId: null }));
  assert.equal(res.isError, true);
  assert.equal(calls.appendMessage, undefined);
});

// ── propose_memory ──────────────────────────────────────────────────────────

test("propose_memory: a PROPOSED note (customer defaults to the request's) and a memory card in the thread", async () => {
  const res = await run("propose_memory", { scope: "CUSTOMER", text: "Quantities print in bold.", sourceKind: "CORRECTION" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.createProposedMemory[0], {
    scope: "CUSTOMER",
    scopeRef: CUSTOMER_ID,
    text: "Quantities print in bold.",
    sourceKind: "CORRECTION",
    sourceRequestId: REQUEST_ID,
  });
  const msg = calls.appendMessage[0] as Row;
  assert.equal(msg.kind, "memory_suggestion");
  assert.deepEqual(msg.meta, { memoryId: "mem-1", scope: "CUSTOMER", scopeRef: CUSTOMER_ID });
  assert.equal(content(res).memoryId, "mem-1");

  // DOC_TYPE defaults to this output's layout doc type.
  await run("propose_memory", { scope: "DOC_TYPE", text: "Stickers keep 5 pt minimum.", sourceKind: "AGENT_FINDING" });
  assert.equal((calls.createProposedMemory[1] as Row).scopeRef, "STICKER");
  assert.equal(logs.at(-1)?.kind, "memory");
});

test("propose_memory: a customer note without a known customer is refused", async () => {
  request.customerId = null;
  const res = await run("propose_memory", { scope: "CUSTOMER", text: "x", sourceKind: "REQUEST" });
  assert.equal(res.isError, true);
  assert.match(content(res).error, /needs scopeRef/);
  assert.equal(calls.createProposedMemory, undefined);
});

// ── finish ──────────────────────────────────────────────────────────────────

test("finish: returns the summary for the reviewer", async () => {
  const res = await run("finish", { summary: "Added QTY: n PCS above the colour line; 12 documents change." });
  assert.deepEqual(res.content, { ok: true, summary: "Added QTY: n PCS above the colour line; 12 documents change." });
  assert.equal(logs[0].kind, "finish");
  assert.equal(tool("finish").input.safeParse({ summary: "  " }).success, false);
});

// ── resumeAwaitingCode ──────────────────────────────────────────────────────

test("resumeAwaitingCode: starts only outputs whose awaited token now exists; a failing start is skipped", async () => {
  waitingOutputs = [
    { id: "o-ready", awaitingToken: "polybagQty" },
    { id: "o-waiting", awaitingToken: "bogusPackQty" },
    { id: "o-fails", awaitingToken: "styleName" },
  ];
  const started: string[] = [];
  const ids = await gap.resumeAwaitingCode(async (id) => {
    if (id === "o-fails") throw new Error("already running");
    started.push(id);
  });
  assert.deepEqual(ids, ["o-ready"]);
  assert.deepEqual(started, ["o-ready"]);
  const where = (calls["changeRequestOutput.findMany"][0] as { where: unknown }).where;
  assert.deepEqual(where, { status: "NEEDS_CODE", awaitingToken: { not: null } });
});

test("resumeAwaitingCode: before the tables exist it does nothing", async () => {
  (waitingOutputs as unknown) = null;
  const ids = await gap.resumeAwaitingCode(async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(ids, []);
});
