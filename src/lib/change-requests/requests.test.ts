import { test, before } from "node:test";
import assert from "node:assert/strict";

// requests.ts imports the Prisma client; a dummy URL lets it load. Nothing
// here touches the database — only the pure parts are under test.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

type Mod = typeof import("./requests");
let m: Mod;
before(async () => {
  m = await import("./requests");
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const img = (fileName = "shot.png") => ({ dataUrl: PNG, fileName });
const output = (over: Record<string, unknown> = {}) => ({
  label: "Polybag sticker",
  variantKey: "layout:bogus-id",
  text: "Show the pack quantity under the size.",
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({ message: "", outputs: [output()], ...over });

// ---------- schema ----------

test("a minimal request parses; blank optional refs read as absent", () => {
  const parsed = m.CreateChangeRequestSchema.parse(body({ title: "", customerId: "  ", poNumber: "PO-0000", styleId: "" }));
  assert.equal(parsed.title, undefined);
  assert.equal(parsed.customerId, undefined);
  assert.equal(parsed.styleId, undefined);
  assert.equal(parsed.poNumber, "PO-0000");
  assert.equal(parsed.outputs[0].label, "Polybag sticker");
});

test("between one and eight outputs", () => {
  assert.equal(m.CreateChangeRequestSchema.safeParse(body({ outputs: [] })).success, false);
  const eight = Array.from({ length: m.MAX_OUTPUTS }, (_, i) => output({ variantKey: `layout:bogus-${i}` }));
  assert.equal(m.CreateChangeRequestSchema.safeParse(body({ outputs: eight })).success, true);
  const nine = [...eight, output({ variantKey: "layout:bogus-9" })];
  assert.equal(m.CreateChangeRequestSchema.safeParse(body({ outputs: nine })).success, false);
});

test("every picked output needs issue text", () => {
  const res = m.CreateChangeRequestSchema.safeParse(body({ outputs: [output({ text: "   " })] }));
  assert.equal(res.success, false);
});

test("the same output can't be picked twice", () => {
  const res = m.CreateChangeRequestSchema.safeParse(body({ outputs: [output(), output()] }));
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error?.issues), /picked once/);
});

test("up to four screenshots per output", () => {
  const four = m.CreateChangeRequestSchema.safeParse(body({ outputs: [output({ attachments: [img(), img(), img(), img()] })] }));
  assert.equal(four.success, true);
  const five = m.CreateChangeRequestSchema.safeParse(
    body({ outputs: [output({ attachments: [img(), img(), img(), img(), img()] })] }),
  );
  assert.equal(five.success, false);
});

test("up to twelve screenshots per request, request-wide ones included", () => {
  const outputs = Array.from({ length: 3 }, (_, i) =>
    output({ variantKey: `layout:bogus-${i}`, attachments: [img(), img(), img(), img()] }),
  );
  assert.equal(m.CreateChangeRequestSchema.safeParse(body({ outputs })).success, true);
  const thirteen = m.CreateChangeRequestSchema.safeParse(body({ outputs, attachments: [img()] }));
  assert.equal(thirteen.success, false);
  assert.match(JSON.stringify(thirteen.error?.issues), /12 images/);
});

test("countImages counts per-output and request-wide screenshots", () => {
  assert.equal(m.countImages({ outputs: [{ attachments: [1, 2] }, {}], attachments: [3] }), 3);
  assert.equal(m.countImages({ outputs: [] }), 0);
});

// ---------- decode ----------

test("every screenshot decodes before anything is written", () => {
  const res = m.decodeRequestAttachments({
    outputs: [output({ attachments: [img("a.png")] }), output({ variantKey: "layout:b", attachments: [img("b.png"), img()] })],
    attachments: [img("general.png")],
  } as never);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.attachments.perOutput.map((list) => list.map((a) => a.fileName)),
    [["a.png"], ["b.png", "shot.png"]],
  );
  assert.equal(res.attachments.general[0].fileName, "general.png");
  assert.equal(res.attachments.general[0].mimeType, "image/png");
});

test("one bad screenshot fails the whole request, naming the output", () => {
  const res = m.decodeRequestAttachments({
    outputs: [output({ attachments: [img(), { dataUrl: "data:text/plain;base64,aGk=" }] })],
  } as never);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /^Polybag sticker:/);
});

test("SVG and GIF are refused — only raster screenshots are served and read", () => {
  for (const dataUrl of ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/gif;base64,R0lGODlh"]) {
    const res = m.decodeRequestAttachments({ outputs: [output({ attachments: [{ dataUrl }] })] } as never);
    assert.equal(res.ok, false, dataUrl);
  }
});

test("the decoder re-checks the limits a caller could skip the schema for", () => {
  const tooMany = m.decodeRequestAttachments({
    outputs: [output({ attachments: [img(), img(), img(), img(), img()] })],
  } as never);
  assert.equal(tooMany.ok, false);
  const total = m.decodeRequestAttachments({
    outputs: Array.from({ length: 4 }, () => output({ attachments: [img(), img(), img(), img()] })),
  } as never);
  assert.equal(total.ok, false);
});

// ---------- small pure helpers ----------

test("default title: first output label, +N more, then the PO", () => {
  assert.equal(m.defaultRequestTitle([{ label: "Polybag sticker" }], "PO-0000"), "Polybag sticker · PO-0000");
  assert.equal(
    m.defaultRequestTitle([{ label: "Polybag sticker" }, { label: "Carton marking" }, { label: "Hangtag" }], null),
    "Polybag sticker +2",
  );
  assert.equal(m.defaultRequestTitle([], undefined), "Change request");
});

test("with nothing pasted, the request message is the issues as typed", () => {
  assert.equal(
    m.composeRequestMessage([
      { label: "Polybag sticker", text: "Bigger quantity. " },
      { label: "Carton marking", text: "Add the PO." },
    ]),
    "Polybag sticker:\nBigger quantity.\n\nCarton marking:\nAdd the PO.",
  );
});

test("layoutId comes only from the variant key", () => {
  assert.equal(m.resolveLayoutId({ variantKey: "layout:abc#m-blue" }), "abc");
  assert.equal(m.resolveLayoutId({ variantKey: "care-label-02" }), null);
  assert.equal(m.resolveLayoutId({}), null);
});

test("the schema drops a client-sent layoutId instead of carrying it", () => {
  const parsed = m.CreateChangeRequestSchema.parse(body({ outputs: [output({ layoutId: "other-layout" })] }));
  assert.equal("layoutId" in parsed.outputs[0], false);
});

// ---------- targets ----------

const facts = (): import("./requests").TargetFacts => ({
  styles: new Map([
    ["style-1", { id: "style-1", customerId: "cust-1", poNumber: "PO-0000", prodSpecId: "spec-1" }],
    ["style-2", { id: "style-2", customerId: "cust-1", poNumber: "PO-0000 ", prodSpecId: "spec-1" }],
    ["style-other-po", { id: "style-other-po", customerId: "cust-1", poNumber: "PO-0001", prodSpecId: "spec-1" }],
    ["style-other-cust", { id: "style-other-cust", customerId: "cust-2", poNumber: "PO-0000", prodSpecId: "spec-1" }],
    ["style-no-spec", { id: "style-no-spec", customerId: "cust-1", poNumber: "PO-0000", prodSpecId: null }],
    ["style-spec-2", { id: "style-spec-2", customerId: "cust-1", poNumber: "PO-0000", prodSpecId: "spec-2" }],
  ]),
  enabledBaseKeys: new Map([
    ["spec-1", new Set(["layout:bogus-id", "care-label-02"])],
    ["spec-2", new Set(["care-label-02"])],
  ]),
});
const targets = (over: Record<string, unknown>) =>
  m.resolveRequestTargets({ outputs: [output()], ...over } as never, facts());
const inputError = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof m.ChangeRequestInputError && err.status === 400 && re.test(err.message));

test("targets: a picked style's customer and PO win over what the client sent", () => {
  const t = targets({ styleId: "style-1", customerId: "cust-evil", poNumber: "PO-9999" });
  assert.equal(t.customerId, "cust-1");
  assert.equal(t.poNumber, "PO-0000");
  assert.deepEqual(t.outputs, [{ variantKey: "layout:bogus-id", layoutId: "bogus-id", styleId: "style-1" }]);
});

test("targets: the layout is read off the base key — a split key is stored as its base", () => {
  const t = targets({ styleId: "style-1", outputs: [output({ variantKey: "layout:bogus-id#m-blue" })] });
  assert.deepEqual(t.outputs[0], { variantKey: "layout:bogus-id", layoutId: "bogus-id", styleId: "style-1" });
  const coded = targets({ styleId: "style-1", outputs: [output({ variantKey: "care-label-02" })] });
  assert.deepEqual(coded.outputs[0], { variantKey: "care-label-02", layoutId: null, styleId: "style-1" });
});

test("targets: a variantKey the style's ProdSpec doesn't print (or has disabled) is a 400", () => {
  inputError(() => targets({ styleId: "style-1", outputs: [output({ variantKey: "layout:someone-elses" })] }), /isn't printed/);
  inputError(() => targets({ styleId: "style-no-spec" }), /isn't printed/);
  inputError(() => targets({ styleId: "style-spec-2" }), /isn't printed/);
});

test("targets: a variantKey with no style to check it against is a 400", () => {
  inputError(() => targets({ poNumber: "PO-0000", customerId: "cust-1" }), /pick the style first/);
  // No key, no style: a free-text issue is fine.
  const t = targets({ outputs: [output({ variantKey: undefined })] });
  assert.deepEqual(t.outputs[0], { variantKey: null, layoutId: null, styleId: null });
});

test("targets: an output's style must be the request's style or one of the same order", () => {
  const t = targets({ styleId: "style-1", outputs: [output({ styleId: "style-2" })] });
  assert.equal(t.outputs[0].styleId, "style-2");
  inputError(() => targets({ styleId: "style-1", outputs: [output({ styleId: "style-other-po" })] }), /this order's styles/);
  inputError(() => targets({ styleId: "style-1", outputs: [output({ styleId: "style-other-cust" })] }), /this order's styles/);
  inputError(() => targets({ styleId: "style-1", outputs: [output({ styleId: "style-gone" })] }), /no longer exists/);
  // The key is checked on both styles it is tied to.
  inputError(() => targets({ styleId: "style-1", outputs: [output({ styleId: "style-spec-2" })] }), /isn't printed/);
});

test("targets: 'all styles in this PO' reads customer + PO from the body and checks the output's style against them", () => {
  const t = targets({ customerId: "cust-1", poNumber: "PO-0000", outputs: [output({ styleId: "style-1" })] });
  assert.equal(t.customerId, "cust-1");
  assert.equal(t.poNumber, "PO-0000");
  assert.equal(t.outputs[0].styleId, "style-1");
  inputError(
    () => targets({ customerId: "cust-2", poNumber: "PO-0000", outputs: [output({ styleId: "style-1" })] }),
    /this order's styles/,
  );
  inputError(
    () => targets({ customerId: "cust-1", poNumber: "PO-0001", outputs: [output({ styleId: "style-1" })] }),
    /this order's styles/,
  );
});

test("targets: a gone picked style is a 400; two keys with one base are one output picked twice", () => {
  inputError(() => targets({ styleId: "style-gone" }), /no longer exists/);
  inputError(
    () =>
      targets({
        styleId: "style-1",
        outputs: [output({ variantKey: "layout:bogus-id#s" }), output({ variantKey: "layout:bogus-id#m" })],
      }),
    /picked once/,
  );
});

test("reviewers list only their own requests; admins list all", () => {
  assert.deepEqual(m.listWhere({ userId: "rev-1", role: "REVIEWER" }), { createdById: "rev-1" });
  assert.deepEqual(m.listWhere({ userId: "rev-1", role: "REVIEWER" }, "IN_REVIEW"), {
    createdById: "rev-1",
    status: "IN_REVIEW",
  });
  assert.deepEqual(m.listWhere({ userId: "admin-1", role: "ADMIN" }), {});
  assert.deepEqual(m.listWhere({ userId: "admin-1", role: "ADMIN" }, "NEW"), { status: "NEW" });
  // No role is never "everything".
  assert.deepEqual(m.listWhere({ userId: "x", role: null }), { createdById: "x" });
});

test("search needs two characters", () => {
  assert.equal(m.normalizeSearchQuery(" a "), null);
  assert.equal(m.normalizeSearchQuery(undefined), null);
  assert.equal(m.normalizeSearchQuery("  PO-0 "), "PO-0");
  assert.equal(m.normalizeSearchQuery("x".repeat(500))?.length, 100);
});
