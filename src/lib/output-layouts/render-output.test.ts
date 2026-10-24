import { test, before } from "node:test";
import assert from "node:assert/strict";
// Type-only — erased at compile time, so nothing loads before the stub below.
import type { OutputTarget } from "./render-output";
import type { LayoutDef } from "./schema";
import type { TemplateVariant } from "@/lib/pdf/template-registry";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import type { StyleFieldValues } from "@/lib/outputs/output-field-values";
import type { InfoAreaSizeInfo } from "@/lib/prod-spec/info-area";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load. Nothing here queries:
// the fixtures print text tokens only (no images, symbols or translations),
// and the DB-backed steps of resolveOutputTarget are covered with a mocked db
// in tests/output-preview-render.test.ts.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let ro: typeof import("./render-output");
let parseLayoutDef: typeof import("./schema").parseLayoutDef;
let layoutRowToVariant: typeof import("./variants").layoutRowToVariant;
let getVariant: typeof import("@/lib/pdf/template-registry").getVariant;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ro = await import("./render-output");
  ({ parseLayoutDef } = await import("./schema"));
  ({ layoutRowToVariant } = await import("./variants"));
  ({ getVariant } = await import("@/lib/pdf/template-registry"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────
const LAYOUT_ID = "bogus-layout";
const KEY = `layout:${LAYOUT_ID}`;
const ROW = {
  id: LAYOUT_ID,
  name: "Test sticker",
  docType: "STICKER",
  version: 3,
  isInfoArea: false,
  customLogo: null,
};

// Stored JSON as the builder writes it — WITHOUT block ids, so the registry's
// parseLayoutDef has to fill them (the definition path must land on the same).
function rawDef(opts: { repeatBy?: string; splitBy?: string; lines?: string[] } = {}): unknown {
  return {
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
            lines: opts.lines ?? ["{{styleNumber}}", "{{size}} · {{customerName}}"],
          },
        ],
      },
    ],
    settings: { repeatBy: opts.repeatBy ?? "size", splitBy: opts.splitBy ?? "ean" },
  };
}

function output(extra: Partial<ProdSpecOutput> = {}): ProdSpecOutput {
  return { variantKey: KEY, widthMm: 40, heightMm: 30, enabled: true, ...extra };
}

function target(
  variant: TemplateVariant,
  opts: {
    output?: ProdSpecOutput;
    fieldValues?: Map<string, StyleFieldValues>;
    infoAreaSizes?: Map<string, InfoAreaSizeInfo>;
    def?: LayoutDef | null;
  } = {},
): OutputTarget {
  return ro.assembleOutputTarget({
    styleId: "bogus-style",
    baseKey: variant.key,
    variant,
    output: opts.output ?? output({ variantKey: variant.key }),
    styleData: buildSampleStyleData(),
    fieldValues: opts.fieldValues ?? new Map(),
    infoAreaSizes: opts.infoAreaSizes ?? new Map(),
    def: opts.def ?? null,
  });
}

function registryVariant(raw: unknown = rawDef(), row: Partial<typeof ROW> = {}): TemplateVariant {
  const v = layoutRowToVariant({ ...ROW, ...row, definition: raw });
  assert.ok(v, "fixture layout must parse");
  return v;
}

const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

// ── Assembly: pins, carton preference, printed size ──────────────────────────

test("assembly applies admin pins, then the style's own values on top, then the carton preference", () => {
  const variant = registryVariant();
  const sample = buildSampleStyleData();
  const t = ro.assembleOutputTarget({
    styleId: "bogus-style",
    baseKey: KEY,
    variant,
    output: output({
      fieldOverrides: { customerName: "Pinned Co", description: "Admin description" },
      cartonBarcodeType: "ean13",
      cartonBarcodeHeightMm: 12,
    }),
    styleData: sample,
    fieldValues: new Map([[KEY, { description: "Style description" }]]),
    infoAreaSizes: new Map(),
  });
  assert.equal(t.styleData.customerName, "Pinned Co");
  assert.equal(t.styleData.description, "Style description", "per-style value wins over the admin pin");
  assert.deepEqual(t.styleData.cartonBarcode, { type: "ean13", heightMm: 12 });
  assert.equal(sample.customerName, "Sample Customer", "the shared StyleData is never mutated");
  assert.equal(t.layoutId, LAYOUT_ID);
});

test("a layout prints at its own page size; the ProdSpec dims only matter for coded variants", () => {
  const t = target(registryVariant());
  assert.deepEqual(t.dims, { widthMm: 40, heightMm: 30 });
  assert.deepEqual(ro.outputPageMm(t.variant, t.dims), { widthMm: 50, heightMm: 30 });

  const coded = getVariant("care-label-01");
  assert.ok(coded);
  assert.deepEqual(ro.outputPageMm(coded, { widthMm: 35, heightMm: 40 }), { widthMm: 35, heightMm: 40 });
});

test("an info area prints at the picked size, falling back to the output's own dims", () => {
  const variant = registryVariant(rawDef(), { isInfoArea: true });
  const sizes = new Map([["size-1", { id: "size-1", name: "Wide", widthMm: 60, heightMm: 40, active: true }]]);
  const picked = target(variant, { output: output({ infoAreaSizeId: "size-1" }), infoAreaSizes: sizes });
  assert.deepEqual(picked.dims, { widthMm: 60, heightMm: 40 });
  assert.deepEqual(ro.outputPageMm(variant, picked.dims), { widthMm: 60, heightMm: 40 });

  const gone = target(variant, { output: output({ infoAreaSizeId: "deleted" }), infoAreaSizes: sizes });
  assert.deepEqual(gone.dims, { widthMm: 40, heightMm: 30 });
});

test("splitVariantKey keeps everything after the first # as the suffix", () => {
  assert.deepEqual(ro.splitVariantKey(KEY), { baseKey: KEY, suffix: null });
  assert.deepEqual(ro.splitVariantKey(`${KEY}#38-BLACK`), { baseKey: KEY, suffix: "38-BLACK" });
});

// ── Documents ────────────────────────────────────────────────────────────────

test("files: a split output emits one document per repetition row, with per-document field overrides", async () => {
  const t = target(registryVariant(), {
    output: output({ fieldOverrides: { customerName: "Pinned Co" } }),
    fieldValues: new Map([[`${KEY}#M`, { customerName: "Doc M Co" }]]),
  });
  const docs = await ro.renderOutputTarget(t, { lines: "none" });
  assert.deepEqual(
    docs.map((d) => d.suffix),
    SIZES,
  );
  for (const d of docs) {
    assert.equal(d.widthMm, 50);
    assert.equal(d.heightMm, 30);
  }
  const m = docs.find((d) => d.suffix === "M")!;
  assert.match(m.html, /M · Doc M Co/);
  const xs = docs.find((d) => d.suffix === "XS")!;
  assert.match(xs.html, /XS · Pinned Co/);
  assert.doesNotMatch(xs.html, /XXL · /, "each file carries only its own row");
});

test("files: an output that does not split emits exactly one document, keyed by the base", async () => {
  const docs = await ro.renderOutputTarget(target(registryVariant(rawDef({ splitBy: "none" }))), { lines: "none" });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].suffix, null);
  for (const size of SIZES) assert.match(docs[0].html, new RegExp(`>${size} · `));
});

test("combined: the whole output in one document, every repetition stacked", async () => {
  const docs = await ro.renderOutputTarget(target(registryVariant()), { documents: "combined", lines: "none" });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].suffix, null);
  for (const size of SIZES) assert.match(docs[0].html, new RegExp(`>${size} · `));
});

test("one suffix: narrows to that document; an unknown suffix renders the whole output", async () => {
  const t = target(registryVariant(), { fieldValues: new Map([[`${KEY}#L`, { customerName: "Doc L Co" }]]) });
  const [l] = await ro.renderOutputTarget(t, { documents: { suffix: "L" }, lines: "none" });
  assert.equal(l.suffix, "L");
  assert.match(l.html, />L · Doc L Co/);
  assert.doesNotMatch(l.html, />XS · /);

  const [whole] = await ro.renderOutputTarget(t, { documents: { suffix: "nope" }, lines: "none" });
  assert.equal(whole.suffix, null);
  for (const size of SIZES) assert.match(whole.html, new RegExp(`>${size} · `));
});

test("line rewrites: the whole-output set reaches every file, a per-document set only its own", async () => {
  const variant = registryVariant();
  const def = parseLayoutDef(rawDef());
  const lineKey = `${def.pages[0].id}|${def.pages[0].blocks[0].id}|0`;
  const t = target(variant);

  const all = await ro.renderOutputTarget(t, { lines: { base: { [lineKey]: "ALL {{styleNumber}}" } } });
  for (const d of all) assert.match(d.html, /ALL STY-10427/);

  const one = await ro.renderOutputTarget(t, {
    lines: { perDoc: new Map([["M", { [lineKey]: "ONLY M" }]]) },
  });
  assert.match(one.find((d) => d.suffix === "M")!.html, /ONLY M/);
  assert.doesNotMatch(one.find((d) => d.suffix === "S")!.html, /ONLY M/);
});

test("carton serial and sibling picks reach the render", async () => {
  const variant = registryVariant(rawDef({ repeatBy: "none", lines: ["Carton {{cartonNo}} of {{cartonTotal}}"] }));
  const [doc] = await ro.renderOutputTarget(target(variant), {
    documents: "combined",
    lines: "none",
    cartonSerial: { no: 2, total: 5 },
  });
  assert.match(doc.html, /Carton 2 of 5/);
});

// ── Unsaved definition ───────────────────────────────────────────────────────

test("a definition equal to the published one renders byte-identical HTML", async () => {
  const raw = rawDef();
  const published = registryVariant(raw);
  const fromDef = ro.variantForDefinition(ROW, parseLayoutDef(raw));
  assert.ok(fromDef);
  const fieldValues = new Map([[`${KEY}#M`, { customerName: "Doc M Co" }]]);
  for (const documents of ["files", "combined", { suffix: "M" }] as const) {
    const a = await ro.renderOutputTarget(target(published, { fieldValues }), { documents, lines: "none" });
    const b = await ro.renderOutputTarget(target(fromDef, { fieldValues }), { documents, lines: "none" });
    assert.deepEqual(b, a, `documents=${JSON.stringify(documents)}`);
  }
});

test("a changed definition is what renders, with its own page size", async () => {
  const proposed = parseLayoutDef(rawDef({ lines: ["{{styleNumber}}", "{{size}} PCS"] }));
  proposed.pages[0].widthMm = 60;
  const v = ro.variantForDefinition(ROW, proposed);
  assert.ok(v);
  const docs = await ro.renderOutputTarget(target(v), { lines: "none" });
  assert.match(docs[0].html, />XS PCS</);
  assert.doesNotMatch(docs[0].html, /Sample Customer/);
  assert.equal(docs[0].widthMm, 60);
});

test("preview mode shows gaps as chips; production drops them", async () => {
  const def = parseLayoutDef(rawDef({ repeatBy: "none", lines: ["Lot {{lot}}"] }));
  const style = buildSampleStyleData();
  style.carton.lot = "";
  const render = async (mode: "preview" | "production") => {
    const v = ro.variantForDefinition(ROW, def, mode);
    assert.ok(v);
    const t = ro.assembleOutputTarget({
      styleId: "bogus-style",
      baseKey: KEY,
      variant: v,
      output: output(),
      styleData: style,
      fieldValues: new Map(),
      infoAreaSizes: new Map(),
      def,
    });
    const [doc] = await ro.renderOutputTarget(t, { documents: "combined", lines: "none" });
    return { t, html: doc.html };
  };
  assert.match((await render("preview")).html, /class="ol-miss"/);
  const prod = await render("production");
  assert.doesNotMatch(prod.html, /class="ol-miss"/);
  assert.deepEqual(await ro.unresolvedForTarget(prod.t), ["{{lot}}"]);
});

test("coded variants report no unresolved tokens", async () => {
  const coded = getVariant("care-label-01");
  assert.ok(coded);
  assert.deepEqual(await ro.unresolvedForTarget(target(coded)), []);
});
