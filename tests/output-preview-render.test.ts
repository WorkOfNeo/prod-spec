// /api/admin/styles/[id]/output-preview after its render moved into
// src/lib/output-layouts/render-output.ts — and renderStyleOutput itself on the
// paths that need the database (registry vs. unsaved definition, stored line
// rewrites, error cases).
//
// The route must answer EXACTLY as before the move. The oracles below are the
// route's previous bodies, verbatim in substance, run against the same mocked
// data: same status codes and bodies for every refusal, byte-identical HTML for
// every render (GET whole output, GET with carton serial + sibling picks, POST
// one document with stored + unsaved line edits, POST base key).
//
// Drives the REAL route handlers and the REAL render pipeline with a mocked
// session, a spy `db` and a mocked style render context — nothing touches a
// database or Chromium. Fixtures are synthetic.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import type { StyleRenderContext } from "@/lib/styles/render-context";

// ── Session ─────────────────────────────────────────────────────────────────
let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
const asAdmin = () => {
  sessionState = { session: { user: { id: "admin-1" } }, role: "ADMIN" };
};
const asReviewer = () => {
  sessionState = { session: { user: { id: "rev-1" } }, role: "REVIEWER" };
};
const asViewer = () => {
  sessionState = { session: { user: { id: "v-1" } }, role: "VIEWER" };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const STYLE_ID = "style-1";
const LAYOUT_ID = "bogus-layout";
const KEY = `layout:${LAYOUT_ID}`;
const DRAFT_ID = "bogus-draft-layout";

// As the builder stores it: no block ids (parseLayoutDef fills them).
const RAW_DEF = {
  pages: [
    {
      id: "p1",
      title: "",
      widthMm: 50,
      heightMm: 30,
      blocks: [
        {
          rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 },
          fontPt: 9,
          lines: ["{{styleNumber}}", "{{size}} · {{customerName}}", "{{description}}", "{{productGroup}}"],
        },
      ],
    },
  ],
  settings: { repeatBy: "size", splitBy: "ean" },
};

const LAYOUT_ROWS = [
  {
    id: LAYOUT_ID,
    name: "Test sticker",
    docType: "STICKER",
    definition: RAW_DEF,
    version: 3,
    isInfoArea: false,
    customLogo: null,
    status: "PUBLISHED",
  },
  {
    id: DRAFT_ID,
    name: "Draft sticker",
    docType: "STICKER",
    definition: RAW_DEF,
    version: 0,
    isInfoArea: false,
    customLogo: null,
    status: "DRAFT",
  },
];

let fieldValueRows: Array<{ variantKey: string; field: string; value: string }> = [];
let lineValueRows: Array<{ variantKey: string; lineKey: string; value: string }> = [];
let renderContextCalls = 0;
let lineKeys: string[] = []; // p1|<block>|0..3, filled once the def is parsed

let STATIC_KEY = "";
let buildSampleStyleData: typeof import("@/lib/pdf/sample-data").buildSampleStyleData;

function makeCtx(): StyleRenderContext {
  const outputs: ProdSpecOutput[] = [
    { variantKey: KEY, widthMm: 40, heightMm: 30, enabled: true, fieldOverrides: { customerName: "Pinned Co" } },
    { variantKey: STATIC_KEY, widthMm: 100, heightMm: 50, enabled: true },
    { variantKey: "care-label-01", widthMm: 35, heightMm: 40, enabled: true },
    { variantKey: `layout:${DRAFT_ID}`, widthMm: 40, heightMm: 30, enabled: true },
  ];
  return {
    styleId: STYLE_ID,
    poSeq: null,
    styleData: buildSampleStyleData(),
    prodSpec: { id: "spec-1", name: "Spec" },
    outputs,
    readiness: [],
  };
}

const dbMock = {
  outputLayout: {
    findMany: async (args: { where?: { status?: string } }) =>
      LAYOUT_ROWS.filter((r) => !args?.where?.status || r.status === args.where.status),
    findUnique: async (args: { where: { id: string } }) => LAYOUT_ROWS.find((r) => r.id === args.where.id) ?? null,
  },
  styleOutputFieldValue: {
    findFirst: async () => ({ id: "probe" }),
    findMany: async () => fieldValueRows,
  },
  styleOutputLineValue: {
    findFirst: async () => ({ id: "probe" }),
    findMany: async () => lineValueRows,
  },
  infoAreaSize: { findMany: async () => [] },
};

type RouteModule = typeof import("@/app/api/admin/styles/[id]/output-preview/route");
let GET: RouteModule["GET"];
let POST: RouteModule["POST"];
let ro: typeof import("@/lib/output-layouts/render-output");
let parseLayoutDef: typeof import("@/lib/output-layouts/schema").parseLayoutDef;
let getVariant: typeof import("@/lib/pdf/template-registry").getVariant;
let ensureLayoutVariantsLoaded: typeof import("@/lib/output-layouts/variants").ensureLayoutVariantsLoaded;
let pins: typeof import("@/lib/pdf/pins");
let fv: typeof import("@/lib/outputs/output-field-values");
let lv: typeof import("@/lib/outputs/output-line-values");
let ia: typeof import("@/lib/prod-spec/info-area");

before(async () => {
  mock.module("@/lib/auth-server", {
    namedExports: {
      getServerSession: async () => sessionState.session,
      getSessionWithRole: async () => sessionState,
    },
  });
  mock.module("@/lib/db", { namedExports: { db: dbMock } });
  mock.module("@/lib/styles/render-context", {
    namedExports: {
      loadStyleRenderContext: async (id: string) => {
        renderContextCalls++;
        return id === STYLE_ID ? makeCtx() : null;
      },
    },
  });

  ({ buildSampleStyleData } = await import("@/lib/pdf/sample-data"));
  ({ GET, POST } = await import("@/app/api/admin/styles/[id]/output-preview/route"));
  ro = await import("@/lib/output-layouts/render-output");
  ({ parseLayoutDef } = await import("@/lib/output-layouts/schema"));
  ({ ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants"));
  const registry = await import("@/lib/pdf/template-registry");
  getVariant = registry.getVariant;
  pins = await import("@/lib/pdf/pins");
  fv = await import("@/lib/outputs/output-field-values");
  lv = await import("@/lib/outputs/output-line-values");
  ia = await import("@/lib/prod-spec/info-area");

  const staticVariant = registry.TEMPLATE_VARIANTS.find((v) => v.staticPdf);
  assert.ok(staticVariant, "the registry carries at least one static-pdf passthrough variant");
  STATIC_KEY = staticVariant.key;

  const def = parseLayoutDef(RAW_DEF);
  const page = def.pages[0];
  lineKeys = page.blocks[0].lines.map((_, i) => `${page.id}|${page.blocks[0].id}|${i}`);
});

beforeEach(() => {
  asAdmin();
  renderContextCalls = 0;
  fieldValueRows = [
    { variantKey: KEY, field: "description", value: "Style description" },
    { variantKey: `${KEY}#M`, field: "customerName", value: "Doc M Co" },
  ];
  lineValueRows = [
    { variantKey: KEY, lineKey: lineKeys[0], value: "STORED {{styleNumber}}" },
    { variantKey: `${KEY}#M`, lineKey: lineKeys[2], value: "STORED FOR M" },
  ];
});

const getReq = (qs: string) =>
  new NextRequest(`http://localhost/api/admin/styles/${STYLE_ID}/output-preview?${qs}`);
const postReq = (body: unknown) =>
  new NextRequest(`http://localhost/api/admin/styles/${STYLE_ID}/output-preview`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const params = (id = STYLE_ID) => ({ params: Promise.resolve({ id }) });

// ── Oracles: the route's previous render steps ──────────────────────────────
async function oldTarget(baseKey: string) {
  await ensureLayoutVariantsLoaded();
  const variant = getVariant(baseKey)!;
  const context = makeCtx();
  const output = context.outputs.find((o) => o.variantKey === baseKey)!;
  const fieldValues = await fv.loadStyleFieldValues(STYLE_ID);
  const overrides = fv.mergeFieldOverrides(
    output.fieldOverrides,
    fieldValues.get(fv.ignoreBaseKey(baseKey, variant.docType)),
  );
  const styleData = pins.applyCartonBarcodePrefs(pins.applyFieldOverrides(context.styleData, overrides), output);
  const dims = ia.effectiveOutputDims(output, variant.isInfoArea ?? false, await ia.loadInfoAreaSizeMap());
  return { variant, styleData, dims, fieldValues };
}

async function oldGet(
  variantKey: string,
  opts: { siblingIds?: string; cartonSerial?: { no: number; total: number } } = {},
) {
  const { variant, dims, styleData } = await oldTarget(variantKey.split("#")[0]);
  let renderStyle = styleData;
  if (opts.siblingIds !== undefined) {
    renderStyle = pins.withSelectedSiblings(renderStyle, opts.siblingIds.split(",").filter(Boolean));
  }
  if (opts.cartonSerial) renderStyle = { ...renderStyle, cartonSerial: opts.cartonSerial };
  return variant.render(renderStyle, dims);
}

async function oldPost(variantKey: string, pending: Record<string, unknown>) {
  const baseKey = variantKey.split("#")[0];
  const { variant, styleData, dims, fieldValues } = await oldTarget(baseKey);
  let renderStyle = styleData;
  const hashIdx = variantKey.indexOf("#");
  if (hashIdx >= 0 && variant.docStyles) {
    const suffix = variantKey.slice(hashIdx + 1);
    const doc = variant.docStyles(styleData).find((d) => d.suffix === suffix);
    if (doc) renderStyle = pins.applyFieldOverrides(doc.style, fieldValues.get(variantKey));
  }
  const stored = await lv.loadStyleLineValues(STYLE_ID);
  const lines: Record<string, string> = {
    ...(lv.mergeLineValues(stored.get(baseKey), variantKey === baseKey ? undefined : stored.get(variantKey)) ?? {}),
  };
  for (const [key, value] of Object.entries(pending)) {
    if (!lv.isLineKey(key) || typeof value !== "string") continue;
    if (value.trim()) lines[key] = value.slice(0, lv.MAX_LINE_LENGTH);
    else delete lines[key];
  }
  return variant.render(renderStyle, dims, Object.keys(lines).length > 0 ? lines : undefined);
}

// ── Gates and refusals (unchanged answers) ──────────────────────────────────

test("GET: no session → 401; no variantKey → 400", async () => {
  asAnon();
  assert.equal((await GET(getReq(`variantKey=${KEY}`), params())).status, 401);
  asAdmin();
  const res = await GET(getReq(""), params());
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "variantKey required" });
});

test("POST: no session → 401, a non-review role → 403, a reviewer passes", async () => {
  asAnon();
  assert.equal((await POST(postReq({ variantKey: KEY }), params())).status, 401);
  asViewer();
  assert.equal((await POST(postReq({ variantKey: KEY }), params())).status, 403);
  asReviewer();
  assert.equal((await POST(postReq({ variantKey: KEY }), params())).status, 200);
});

test("refusals keep their status and body", async () => {
  const cases: Array<[string, string, number, unknown]> = [
    ["unknown variant", "layout:nope", 404, { error: "Unknown variant" }],
    ["unpublished layout", `layout:${DRAFT_ID}`, 404, { error: "Unknown variant" }],
    ["output not on the spec", "care-label-02", 404, { error: "Output not configured on this style's ProdSpec" }],
  ];
  for (const [label, key, status, body] of cases) {
    const res = await GET(getReq(`variantKey=${encodeURIComponent(key)}`), params());
    assert.equal(res.status, status, label);
    assert.deepEqual(await res.json(), body, label);
    const post = await POST(postReq({ variantKey: key }), params());
    assert.equal(post.status, status, `${label} (POST)`);
    assert.deepEqual(await post.json(), body, `${label} (POST)`);
  }

  const missing = await GET(getReq(`variantKey=${KEY}`), params("style-missing"));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Style not found" });

  const stat = await GET(getReq(`variantKey=${encodeURIComponent(STATIC_KEY)}`), params());
  assert.equal(stat.status, 409);
  assert.deepEqual(await stat.json(), {
    staticPdf: true,
    message: "Static artwork passthrough — the output is the committed source PDF.",
  });
});

// ── Renders (byte-identical to before) ──────────────────────────────────────

test("GET renders the whole output exactly as before, whatever suffix the link carries", async () => {
  for (const key of [KEY, `${KEY}#M`]) {
    const res = await GET(getReq(`variantKey=${encodeURIComponent(key)}`), params());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.equal(html, await oldGet(key), key);
    assert.match(html, /XS · Pinned Co/);
    assert.match(html, /Style description/);
    assert.doesNotMatch(html, /STORED/, "the card preview ignores stored line rewrites, as before");
  }
});

test("GET with carton serial and sibling picks matches the old render", async () => {
  const res = await GET(getReq(`variantKey=${KEY}&cartonNo=2&cartonTotal=5&siblingIds=`), params());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), await oldGet(KEY, { siblingIds: "", cartonSerial: { no: 2, total: 5 } }));
});

test("GET of a coded variant matches the old render", async () => {
  const res = await GET(getReq("variantKey=care-label-01"), params());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), await oldGet("care-label-01"));
});

test("POST one document: narrowed row, per-doc field value, stored + unsaved line edits — as before", async () => {
  const pending = { [lineKeys[1]]: "PENDING {{size}}", [lineKeys[0]]: "  ", bogus: "ignored" };
  const res = await POST(postReq({ variantKey: `${KEY}#M`, lineOverrides: pending }), params());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html, await oldPost(`${KEY}#M`, pending));
  assert.match(html, /PENDING M/);
  assert.match(html, /STORED FOR M/);
  assert.doesNotMatch(html, /STORED STY/, "a blank pending value clears the stored rewrite");
  assert.doesNotMatch(html, /XS/);
});

test("POST base key and unknown suffix render the whole output, as before", async () => {
  for (const key of [KEY, `${KEY}#nope`]) {
    const res = await POST(postReq({ variantKey: key, lineOverrides: {} }), params());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), await oldPost(key, {}), key);
  }
});

// ── renderStyleOutput on the database-backed paths ──────────────────────────

test("renderStyleOutput: the published definition passed as `definition` renders identically", async () => {
  const live = await ro.renderStyleOutput({ styleId: STYLE_ID, variantKey: KEY, mode: "production" });
  const same = await ro.renderStyleOutput({
    styleId: STYLE_ID,
    variantKey: KEY,
    mode: "production",
    definition: parseLayoutDef(RAW_DEF),
  });
  assert.deepEqual(same, live);
  assert.equal(live.docs.length, 6);
  assert.deepEqual(live.unresolved, ["{{productGroup}}"]);
});

test("renderStyleOutput files: runner semantics — stored line rewrites and per-doc values per file", async () => {
  const { docs } = await ro.renderStyleOutput({ styleId: STYLE_ID, variantKey: KEY, mode: "production" });
  const m = docs.find((d) => d.suffix === "M")!;
  const s = docs.find((d) => d.suffix === "S")!;
  assert.match(m.html, /STORED STY-10427/);
  assert.match(m.html, /STORED FOR M/);
  assert.match(m.html, /M · Doc M Co/);
  assert.doesNotMatch(s.html, /STORED FOR M/);
  assert.match(s.html, /S · Pinned Co/);
  assert.deepEqual([m.widthMm, m.heightMm], [50, 30]);

  // Oracle: the runner's renderMany call for this output.
  const { variant, styleData, dims, fieldValues } = await oldTarget(KEY);
  const perDoc = new Map<string, Record<string, string>>();
  for (const [k, v] of fieldValues) if (k.startsWith(`${KEY}#`)) perDoc.set(k.slice(KEY.length + 1), v as Record<string, string>);
  const split = lv.splitLineValues(await lv.loadStyleLineValues(STYLE_ID), KEY);
  const runner = await variant.renderMany!(styleData, dims, perDoc, { base: split.base, perDoc: split.perDoc });
  assert.deepEqual(
    docs.map((d) => [d.suffix, d.html]),
    runner.map((d) => [d.suffix, d.html]),
  );
});

test("renderStyleOutput: a proposed definition renders, and a suffix narrows to one document", async () => {
  const proposed = parseLayoutDef(RAW_DEF) as LayoutDef;
  proposed.pages[0].blocks[0].lines[1] = "{{size}} PCS";
  const out = await ro.renderStyleOutput({
    styleId: STYLE_ID,
    variantKey: `${KEY}#L`,
    mode: "production",
    definition: proposed,
    lines: "none",
  });
  assert.equal(out.docs.length, 1);
  assert.equal(out.docs[0].suffix, "L");
  assert.match(out.docs[0].html, />L PCS</);
});

test("renderStyleOutput with a loaded context does not rebuild StyleData", async () => {
  const ctx = makeCtx();
  renderContextCalls = 0;
  const a = await ro.renderStyleOutput({ ctx, variantKey: KEY, mode: "production" });
  const b = await ro.renderStyleOutput({ ctx, variantKey: KEY, mode: "production", definition: parseLayoutDef(RAW_DEF) });
  assert.equal(renderContextCalls, 0);
  assert.deepEqual(b, a);
});

test("renderStyleOutput: preview mode, drafts of unpublished layouts, and refusals", async () => {
  const preview = await ro.renderStyleOutput({ styleId: STYLE_ID, variantKey: KEY, mode: "preview", lines: "none" });
  assert.match(preview.docs[0].html, /class="ol-miss"/);

  // An unsaved definition may target a layout that is not published yet…
  const draft = await ro.renderStyleOutput({
    styleId: STYLE_ID,
    variantKey: `layout:${DRAFT_ID}`,
    mode: "production",
    definition: parseLayoutDef(RAW_DEF),
  });
  assert.equal(draft.docs.length, 6);
  // …but without one it renders only what the registry would.
  await assert.rejects(
    ro.renderStyleOutput({ styleId: STYLE_ID, variantKey: `layout:${DRAFT_ID}`, mode: "preview" }),
    (e: unknown) => e instanceof ro.RenderOutputError && e.code === "UNKNOWN_VARIANT" && e.status === 404,
  );

  await assert.rejects(
    ro.renderStyleOutput({
      styleId: STYLE_ID,
      variantKey: "care-label-01",
      mode: "production",
      definition: parseLayoutDef(RAW_DEF),
    }),
    (e: unknown) => e instanceof ro.RenderOutputError && e.code === "NOT_A_LAYOUT" && e.status === 400,
  );
  await assert.rejects(
    ro.renderStyleOutput({
      styleId: STYLE_ID,
      variantKey: KEY,
      mode: "production",
      definition: { pages: [] } as unknown as LayoutDef,
    }),
    (e: unknown) => e instanceof ro.RenderOutputError && e.code === "INVALID_DEFINITION",
  );
  await assert.rejects(
    ro.renderStyleOutput({ styleId: STYLE_ID, variantKey: STATIC_KEY, mode: "production" }),
    (e: unknown) => e instanceof ro.RenderOutputError && e.code === "STATIC_PDF" && e.status === 409,
  );
});
