// =====================================================
// Change-request bench — the agent's tools, served from a case file.
//
// fixtureTools(benchCase) returns the PRODUCTION tool list (agent/tools.ts:
// every tool's name, description and zod input exactly as shipped) with only
// `run` swapped for an implementation over one frozen case. So the bench runs
// the production loop and prompt against the real model, the model sees the
// very tool definitions it sees in the app, and the only thing different is
// where the tools read from:
//
//   get_request / find_layouts / get_layout     the case's request and layout
//   find_styles_by_value / list_tokens          the case's styles as StyleData
//                                               (sample data + overrides), read
//                                               through the production resolvers
//   propose_patch                               applyLayoutOps in memory; drafts
//                                               (revisions) live in `state` only
//   render_proof / impact_list                  the production per-output render
//                                               (render-output.ts: pins, carton
//                                               preference, one document per file;
//                                               no stored line rewrites) and the
//                                               production comparison (impact.ts)
//   declare_gap / ask_reviewer / propose_memory captured in `state`; nothing is
//   / finish                                    sent or stored
//
// Results mirror the production result shapes, built with the same helpers
// where they are exported (summariseLayoutDef, summariseValueMatches,
// tokenCatalogue, tokenArgVariants, buildImpactRows, summarise,
// rasteriseProofDoc), so the model reads the same kind of output it would in a
// live run.
//
// `removeTokens` hides tokens as if they did not exist yet: list_tokens leaves
// them out, propose_patch refuses lines that use them (with the reason the
// publish gate gives for an unknown variable) and declare_gap accepts them as
// new. That is how a case asks "does the agent stop and hand over instead of
// faking it?".
//
// No database: agent/tools.ts and the render stack import `@/lib/db`, so they
// are loaded lazily, after the offline stand-in (offline-db.ts) is installed —
// which is why fixtureTools is async. Proof pictures need a browser
// (PUPPETEER_EXECUTABLE_PATH or Puppeteer's own); without one, render_proof
// answers with a text reading of the rendered document and says the pictures
// are unavailable.
// =====================================================

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { StyleData } from "@/lib/pdf/types";
import { applyLayoutOps, describeLayoutChanges, type LayoutOp } from "@/lib/output-layouts/ops";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { tokenMeta } from "@/lib/output-layouts/token-meta";
import type { RenderedOutputDoc } from "@/lib/output-layouts/render-output";
import type { AgentTool, AgentToolName, ToolContext, ToolImage, ToolResult } from "../agent/contract";
import { AGENT_TOOL_NAMES } from "../agent/contract";
import { requestRef, type GapDeclaration, type ImpactRow } from "../types";
import { benchStyleData, representativeStyle, type BenchCase, type BenchStyle } from "./case-schema";
import { installOfflineDatabase, registerOfflineWashSymbols } from "./offline-db";
import { lineTokenKeys, type BenchOutcome } from "./score";

// ── State ────────────────────────────────────────────────────────────────────

export type FixtureDraft = {
  // The revision id the tools hand to the model ("bench-rev-1", …).
  id: string;
  number: number;
  parentId: string | null;
  // The live definition plus `ops`.
  definition: LayoutDef;
  ops: LayoutOp[];
  warnings: string[];
  note: string;
};

export type FixtureState = {
  drafts: FixtureDraft[];
  // The first hand-off that succeeded (finish / declare_gap / ask_reviewer).
  terminal?: { name: AgentToolName; input: unknown };
  memories: { scope: string; scopeRef: string | null; text: string; sourceKind: string }[];
};

export type FixtureToolsOptions = {
  // "auto" (default): PNG proofs when a browser launches, text otherwise.
  // "off": always text — tests, or a run that should not spend image tokens.
  images?: "auto" | "off";
  // Device pixels per CSS pixel for proofs (production default 3).
  proofScale?: number;
};

export type FixtureTools = { tools: AgentTool[]; state: FixtureState };

// What the score needs from a finished run (impact is added by the caller,
// which renders it with fixtureImpact).
export function outcomeFromState(state: FixtureState): BenchOutcome {
  const last = state.drafts[state.drafts.length - 1];
  return {
    ...(state.terminal ? { terminal: { name: state.terminal.name, input: state.terminal.input } } : {}),
    drafts: state.drafts.map((d) => ({ definition: d.definition, ops: d.ops })),
    warnings: last ? [...last.warnings] : [],
  };
}

// ── Runtime (lazy: production tools, render stack, impact, proofs) ──────────

async function importRuntime() {
  const symbols = await import("@/lib/pdf/washcare-symbols");
  registerOfflineWashSymbols(symbols.STANDARD_WASHCARE_SYMBOLS);
  const [tools, gap, renderOutput, impact, proofs, tokens, customers] = await Promise.all([
    import("../agent/tools"),
    import("../gap"),
    import("@/lib/output-layouts/render-output"),
    import("../impact"),
    import("../proofs"),
    import("@/lib/output-layouts/tokens"),
    import("@/lib/customers/config"),
  ]);
  return { tools, gap, renderOutput, impact, proofs, tokens, customers };
}

type Runtime = Awaited<ReturnType<typeof importRuntime>>;
let runtime: Promise<Runtime> | null = null;

// Installs the offline database stand-in (unless a real client already
// exists), then loads the production tools and the render stack. Safe to call
// repeatedly; new wash-symbol codes are registered on every call.
export async function loadBenchRuntime(washCodes: readonly string[] = []): Promise<Runtime> {
  installOfflineDatabase();
  runtime ??= importRuntime();
  const rt = await runtime;
  registerOfflineWashSymbols(washCodes.map((code) => ({ code })));
  return rt;
}

function caseWashCodes(c: BenchCase): string[] {
  return [...new Set(c.styles.flatMap((s) => benchStyleData(c, s.id).washSymbols))];
}

// ── The first message ────────────────────────────────────────────────────────

const OUTPUT_ID = "bench-output";
const CUSTOMER_ID = "bench-customer";

// The production first message (job.ts buildFirstMessage) for this case, built
// from what job.ts would have loaded from the database: the request, its one
// output and the screenshots.
export async function benchFirstMessage(
  c: BenchCase,
  imagePaths: readonly string[] = [],
): Promise<{ content: Anthropic.Beta.BetaContentBlockParam[]; images: number }> {
  await loadBenchRuntime();
  const { buildFirstMessage } = await import("../agent/job");
  type Input = Parameters<typeof buildFirstMessage>[0];
  const rep = representativeStyle(c);
  const output = {
    id: OUTPUT_ID,
    label: c.request.outputLabel,
    text: c.request.text,
    variantKey: `layout:${c.layout.id}`,
    layoutId: c.layout.id,
    styleId: rep.id,
    awaitingToken: null,
  };
  const attachments = imagePaths.map((path, i) => ({
    id: `bench-image-${i + 1}`,
    outputId: null,
    data: new Uint8Array(readFileSync(path)),
    mimeType: IMAGE_MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    fileName: basename(path),
  }));
  return buildFirstMessage({
    // Only the fields buildFirstMessage reads; the rest of a request row is
    // database bookkeeping.
    detail: {
      number: 0,
      title: c.title,
      message: c.request.message,
      source: "ADMIN",
      poNumber: benchStyleData(c, rep.id).poNumber ?? null,
      styleId: rep.id,
      outputs: [output],
      messages: [],
    } as unknown as Input["detail"],
    output,
    trigger: "new",
    currentDraft: null,
    attachments: attachments as Input["attachments"],
  });
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── Rendering ────────────────────────────────────────────────────────────────

// One style's documents for this output, through the production per-output
// render (variant for the definition → pins / carton preference / size → one
// document per file), as renderStyleOutput emits them. Stored reviewer line
// rewrites are left out: a case has none.
export async function renderFixtureDocs(c: BenchCase, def: LayoutDef, styleId: string): Promise<RenderedOutputDoc[]> {
  const { renderOutput } = await loadBenchRuntime(caseWashCodes(c));
  const page = def.pages[0];
  const variant = renderOutput.variantForDefinition(
    { id: c.layout.id, name: c.layout.name, docType: c.layout.docType, version: 1, isInfoArea: false, customLogo: null },
    def,
  );
  if (!variant) throw new Error(`Layout ${c.layout.id} does not build a variant`);
  const target = renderOutput.assembleOutputTarget({
    styleId,
    baseKey: variant.key,
    variant,
    output: { variantKey: variant.key, widthMm: page.widthMm, heightMm: page.heightMm, enabled: true },
    styleData: benchStyleData(c, styleId),
    fieldValues: new Map(),
    infoAreaSizes: new Map(),
    def,
  });
  return renderOutput.renderOutputTarget(target, { documents: "files", lines: "none" });
}

// A plain reading of a rendered document, page by page and block by block,
// with each block's box in mm — what render_proof says when it can't send a
// picture. Graphics are named, not drawn: "barcode [5701234567890]".
export function htmlTextSummary(html: string, maxPages = Number.POSITIVE_INFINITY): string[] {
  const body = html.includes("<body") ? html.slice(html.indexOf("<body")) : html;
  const out: string[] = [];
  const pages = body.split(/<div class="ol-page\b/).slice(1);
  pages.slice(0, maxPages).forEach((page, p) => {
    if (pages.length > 1) out.push(`Page ${p + 1} of ${pages.length}:`);
    const blocks = page.split(/<div class="ol-block\b/).slice(1);
    for (const chunk of blocks) {
      const style = /style="([^"]*)"/.exec(chunk)?.[1] ?? "";
      const mm = (prop: string) => new RegExp(`(?:^|[;\\s])${prop}:\\s*([\\d.]+)mm`).exec(style)?.[1];
      const box = ["left", "top", "width", "height"].map(mm);
      // The chunk starts inside the block's opening tag; drop the rest of it.
      const text = chunk
        .slice(chunk.indexOf(">") + 1)
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "")
        .replace(/<span class="ol-barcode">/g, " barcode ")
        .replace(/<span class="ol-symbols">/g, " symbols ")
        .replace(/<span class="missing"[^>]*>([\s\S]*?)<\/span>/g, "[missing: $1]")
        .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, "[$1]")
        .replace(/<img\b[^>]*>/g, "[image]")
        .replace(/<svg[\s\S]*?<\/svg>/g, "[graphic]")
        .replace(/<div class="ol-line">/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
      const lines = text
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (!lines.length) continue;
      const where = box.every(Boolean) ? `at ${box[0]},${box[1]} mm (${box[2]}×${box[3]} mm)` : "block";
      out.push(`${where}: ${lines.join(" / ")}`);
    }
  });
  if (pages.length > maxPages) out.push(`(${pages.length - maxPages} more page${pages.length - maxPages === 1 ? "" : "s"} not shown)`);
  return out;
}

// Which documents `proposed` changes, against the case's layout: the
// production comparison (impact.ts compareDocs, i.e. what PRINTS) per style,
// then the production rows with the delivery side empty (nothing in a case
// was ever generated, approved or sent).
export type FixtureImpact = {
  // Per style: does any of its documents change?
  rows: { styleId: string; styleLabel: string; group?: BenchStyle["group"]; changed: boolean }[];
  // Per document, as impact_list counts them.
  docRows: ImpactRow[];
  errors: { styleId: string; message: string }[];
};

export async function fixtureImpact(c: BenchCase, proposed: LayoutDef): Promise<FixtureImpact> {
  const { impact } = await loadBenchRuntime(caseWashCodes(c));
  const baseKey = `layout:${c.layout.id}`;
  const comparisons: Parameters<typeof impact.buildImpactRows>[0][number][] = [];
  const rows: FixtureImpact["rows"] = [];
  const errors: FixtureImpact["errors"] = [];
  for (const s of c.styles) {
    try {
      const [before, after] = await Promise.all([
        renderFixtureDocs(c, c.layout.definition, s.id),
        renderFixtureDocs(c, proposed, s.id),
      ]);
      const docs = impact.compareDocs(before, after);
      comparisons.push({ styleId: s.id, styleLabel: s.label, poNumber: benchStyleData(c, s.id).poNumber ?? null, baseKey, docs });
      rows.push({ styleId: s.id, styleLabel: s.label, ...(s.group ? { group: s.group } : {}), changed: docs.some((d) => d.changed) });
    } catch (err) {
      errors.push({ styleId: s.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const docRows = impact.buildImpactRows(comparisons, {
    reviewByStyle: new Map(),
    deliveryByStyle: new Map(),
    inFlight: new Set(),
  });
  return { rows, docRows, errors };
}

// ── Proof pictures ───────────────────────────────────────────────────────────

let browser: { ok: true } | { ok: false; reason: string } | null = null;

type Picked = { png?: Buffer; doc: number; suffix: string | null; widthMm: number; heightMm: number; html: string };

// One document of a rendered output — by suffix, else the first, as
// production picks it — as a PNG through production's rasteriseProofDoc when
// a browser is available.
async function pictureOf(
  rt: Runtime,
  docs: RenderedOutputDoc[],
  opts: { suffix?: string; scale: number; images: "auto" | "off" },
): Promise<{ picked: Picked; unavailable?: string }> {
  let index = 0;
  if (opts.suffix !== undefined) {
    index = docs.findIndex((d) => (d.suffix ?? "") === opts.suffix);
    if (index < 0) throw new rt.proofs.ProofNotFoundError("doc", `This output has no document "${opts.suffix}"`);
  }
  const doc = docs[index];
  if (!doc) throw new rt.proofs.ProofNotFoundError("doc", "This output renders no document for the style");
  const picked: Picked = { doc: index, suffix: doc.suffix, widthMm: doc.widthMm, heightMm: doc.heightMm, html: doc.html };
  if (opts.images === "off") return { picked, unavailable: "proof pictures are switched off for this run" };
  if (browser && !browser.ok) return { picked, unavailable: browser.reason };
  try {
    const proof = await rt.proofs.rasteriseProofDoc(docs, { doc: index, scale: opts.scale });
    browser = { ok: true };
    return { picked: { ...picked, png: proof.png } };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
    // The first failure is almost always "no browser here": stop trying.
    if (!browser) browser = { ok: false, reason };
    return { picked, unavailable: reason };
  }
}

// ── The tools ────────────────────────────────────────────────────────────────

// The syntax notes production list_tokens returns (private in agent/tools.ts),
// mirrored so the result reads the same.
const SYNTAX_NOTES = [
  "A line holds text and variables: {{key}} or {{key:arg}} (no spaces inside the braces).",
  'Conditionals (one level): {{if field op "value"}}…{{else}}…{{endif}} with op == != contains !contains includes !includes. {{if key != ""}}…{{endif}} prints only when the variable has a value.',
  "Calculations: {{= expr }}.",
  "Sibling-style slots ({{style2}}, {{style3Name}}, …) exist for multi-style carton markings only.",
];

// The case's styles as Monday columns: where each StyleData field comes from
// (the mapped field production reports as `mappedAs`, whose default column id
// is DEFAULT_COLUMN_MAPPING's) and a title. Only fields read from a board
// column — the customer, for one, is a relation, not a column.
const VALUE_COLUMNS: { field: string; mapped: string | null; title: string; value: (s: StyleData) => string | undefined }[] = [
  { field: "styleNumber", mapped: "styleNumber", title: "Name", value: (s) => s.styleNumber },
  { field: "styleName", mapped: null, title: "Style Name", value: (s) => s.styleName },
  { field: "trimsRaw", mapped: "trims", title: "Trims", value: (s) => s.trimsRaw },
  { field: "productGroup", mapped: "productGroup", title: "Product Group", value: (s) => s.productGroup },
  { field: "styleCommentsRaw", mapped: "styleComments", title: "Style Comments", value: (s) => s.styleCommentsRaw },
  { field: "cartonQtyRaw", mapped: "cartonQty", title: "Qty/Carton", value: (s) => s.cartonQtyRaw },
  { field: "sizeRatioRaw", mapped: "sizeRatio", title: "Size Ratio", value: (s) => s.sizeRatioRaw },
  { field: "customerItemNo", mapped: "customerItemNo", title: "Customer Item No", value: (s) => s.customerItemNoRaw ?? s.customerItemNo },
  { field: "description", mapped: "description", title: "Description", value: (s) => s.description },
  { field: "poNumber", mapped: "poNumber", title: "PO Number", value: (s) => s.poNumber },
  { field: "customerOrderNo", mapped: "customerOrderNo", title: "Customer Order Number", value: (s) => s.customerOrderNo },
  { field: "countryOfOrigin", mapped: "countryOfOrigin", title: "Country of Origin", value: (s) => s.countryOfOrigin },
  { field: "campaignWeek", mapped: "campaignWeek", title: "Campaign Week", value: (s) => s.campaignWeek },
  { field: "batchNo", mapped: "batchNo", title: "Batch nr", value: (s) => s.batchNo },
  { field: "prodNumber", mapped: "prodNumber", title: "Prod number", value: (s) => s.prodNumber },
  { field: "deliveryTerm", mapped: "deliveryTerm", title: "Shipping Terms", value: (s) => s.deliveryTerm },
  { field: "composition", mapped: "composition", title: "Composition", value: (s) => s.composition.find((x) => x.language === "en")?.text },
  { field: "colourName", mapped: "colourName", title: "Color Name From Client", value: (s) => s.colour?.name },
  { field: "washSymbols", mapped: "washCare", title: "Wash Care Symbols", value: (s) => s.washSymbols.join(", ") },
  { field: "sizes", mapped: "sizes", title: "Sizes", value: (s) => s.sizes.map((x) => x.label).join(", ") },
  { field: "price", mapped: "price", title: "Retail Prices", value: (s) => s.price?.amount.toFixed(2).replace(".", ",") },
  { field: "certificates", mapped: "certificates", title: "Certificates", value: (s) => (s.certificates ?? []).join(", ") },
];
const BOARD = { id: "bench-styles-board", name: "Styles" };

// Inputs as agent/tools.ts declares them. The loop parses every input with the
// production schema before run() sees it; these types only name the fields
// the fixture reads.
type FindStylesInput = { text: string; columnHint?: string; customerId?: string; limit?: number };
type GetLayoutInput = { layoutId: string; live?: boolean };
type ListTokensInput = { styleId?: string; query?: string };
type ProposePatchInput = { layoutId: string; ops: LayoutOp[]; note: string };
type RenderProofInput = { revisionId: string; styleId: string; side?: "before" | "after" | "both"; suffix?: string };
type ImpactListInput = { revisionId: string };
type AskReviewerInput = { question: string; to: "admin" | "requester" };
type ProposeMemoryInput = { scope: string; scopeRef?: string; text: string; sourceKind: string };
type FinishInput = { summary: string };

type FixtureRun = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

function ok(content: Record<string, unknown>, images?: ToolImage[]): ToolResult {
  return images && images.length > 0 ? { content, images } : { content };
}

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { isError: true, content: { error, ...extra } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export async function fixtureTools(benchCase: BenchCase, opts: FixtureToolsOptions = {}): Promise<FixtureTools> {
  const c = benchCase;
  const rt = await loadBenchRuntime(caseWashCodes(c));
  const images = opts.images ?? "auto";
  const scale = opts.proofScale ?? rt.proofs.DEFAULT_PROOF_SCALE;
  const state: FixtureState = { drafts: [], memories: [] };
  const removed = new Set(c.removeTokens ?? []);
  const rep = representativeStyle(c);
  const repData = benchStyleData(c, rep.id);
  const layout = c.layout;
  const live = layout.definition;
  const layoutRow = { id: layout.id, name: layout.name, docType: layout.docType, status: "PUBLISHED", version: 1 };
  let messages = 0;

  const styleById = (id: string) => c.styles.find((s) => s.id === id);
  // Production points the output at its newest draft (currentRevisionId).
  const currentDraft = () => state.drafts[state.drafts.length - 1] ?? null;
  const draftById = (id: string) => state.drafts.find((d) => d.id === id) ?? null;
  const capture = (name: AgentToolName, input: unknown) => {
    state.terminal ??= { name, input: structuredClone(input) };
  };

  // Lines an op writes, and why it can't use a hidden token.
  const hiddenTokenError = (op: LayoutOp): string | null => {
    const lines =
      op.op === "add_block" ? op.block.lines : op.op === "edit_line" ? [op.newText] : op.op === "insert_line" ? [op.text] : [];
    for (const line of lines) {
      const hidden = lineTokenKeys(line).filter((k) => removed.has(k));
      if (hidden.length) {
        const why = hidden.map((k) => `unknown variable {{${k}}}`).join("; ");
        return `line ${JSON.stringify(line.length > 120 ? `${line.slice(0, 119)}…` : line)}: ${why}`;
      }
    }
    return null;
  };

  // What resolvedTokens (gap.ts) returns, for a fixture style: every text
  // variable through the same augments and resolvers, "en" plus the style's
  // first output language — removed tokens left out.
  const resolvedFor = async (styleId: string) => {
    const s = styleById(styleId);
    if (!s) return null;
    const base = benchStyleData(c, s.id);
    const firstLang = (base.outputLanguages ?? []).map((l) => l.toLowerCase()).find(Boolean);
    const languages = [...new Set(["en", ...(firstLang ? [firstLang] : [])])];
    let style = await rt.tokens.augmentCompositionTranslations(base, languages);
    style = await rt.tokens.augmentTranslatedFields(style, {
      care: languages,
      madeIn: languages,
      madeInLabel: languages,
      country: languages,
      countryOfOriginLabel: languages,
      manufacturer: languages,
    });
    const values: { token: string; key: string; arg?: string; value: string }[] = [];
    const empty: string[] = [];
    for (const entry of rt.gap.tokenCatalogue()) {
      if (entry.kind !== "text" || removed.has(entry.key)) continue;
      if (entry.arg === "lang") {
        let any = false;
        for (const lang of languages) {
          const value = rt.tokens.resolveTextToken(style, entry.key, lang);
          if (!value) continue;
          any = true;
          values.push({ token: `{{${entry.key}:${lang}}}`, key: entry.key, arg: lang, value });
        }
        if (!any) empty.push(entry.key);
        continue;
      }
      const bare = rt.tokens.resolveTextToken(style, entry.key);
      if (bare) values.push({ token: `{{${entry.key}}}`, key: entry.key, value: bare });
      else empty.push(entry.key);
      for (const arg of rt.gap.tokenArgVariants(entry)) {
        const value = rt.tokens.resolveTextToken(style, entry.key, arg);
        if (!value || value === bare) continue;
        values.push({ token: `{{${entry.key}:${arg}}}`, key: entry.key, arg, value });
      }
    }
    return { styleId: s.id, styleLabel: base.styleName || base.styleNumber || s.id, languages, values, empty };
  };

  const runs: Record<AgentToolName, FixtureRun> = {
    get_request: async () => {
      const draft = currentDraft();
      return ok({
        request: {
          ref: requestRef(0),
          number: 0,
          title: c.title,
          status: "WORKING",
          message: c.request.message,
          poNumber: repData.poNumber ?? null,
          customer: { id: CUSTOMER_ID, name: repData.customerName },
          styleId: rep.id,
        },
        output: {
          id: OUTPUT_ID,
          label: c.request.outputLabel,
          text: c.request.text,
          variantKey: `layout:${layout.id}`,
          layoutId: layout.id,
          styleId: rep.id,
          status: "WORKING",
          currentRevisionId: draft?.id ?? null,
          draftCount: 0,
        },
        style: { id: rep.id, label: rep.label, poNumber: repData.poNumber ?? null },
        currentDraft: draft
          ? { revisionId: draft.id, number: draft.number, status: "DRAFT", layoutId: layout.id, note: draft.note }
          : null,
        otherOutputs: [],
        thread: [],
        attachments: (c.images ?? []).map((p) => ({ fileName: basename(p) })),
      });
    },

    find_styles_by_value: async (raw) => {
      const input = raw as FindStylesInput;
      const limit = input.limit ?? 8;
      const needle = input.text.toLowerCase();
      const mapping = rt.customers.DEFAULT_COLUMN_MAPPING as Record<string, string | undefined>;
      const columnIdOf = (col: (typeof VALUE_COLUMNS)[number]) => (col.mapped && mapping[col.mapped]) || `bench_${col.field}`;
      // columnHint → column ids: the hint itself, a mapped field of that name,
      // and every column whose title matches (production's three ways).
      let columnIds: string[] | null = null;
      if (input.columnHint) {
        const hint = input.columnHint.toLowerCase();
        const ids = new Set<string>([input.columnHint]);
        const mapped = mapping[input.columnHint];
        if (mapped) ids.add(mapped);
        for (const col of VALUE_COLUMNS) if (col.title.toLowerCase().includes(hint)) ids.add(columnIdOf(col));
        columnIds = [...ids];
      }
      const inScope = !input.customerId || input.customerId === CUSTOMER_ID;
      const counts = new Map<string, Map<string, number>>();
      const examples: Parameters<typeof rt.tools.summariseValueMatches>[1][number][] = [];
      for (const s of inScope ? c.styles : []) {
        const data = benchStyleData(c, s.id);
        for (const col of VALUE_COLUMNS) {
          const value = col.value(data);
          const id = columnIdOf(col);
          if (!value || !value.toLowerCase().includes(needle) || (columnIds && !columnIds.includes(id))) continue;
          const byValue = counts.get(id) ?? new Map<string, number>();
          byValue.set(value, (byValue.get(value) ?? 0) + 1);
          counts.set(id, byValue);
          examples.push({
            styleId: s.id,
            label: s.label,
            poNumber: data.poNumber ?? null,
            customer: data.customerName,
            mondayBoardId: BOARD.id,
            columnId: id,
            text: value,
          });
        }
      }
      const countRows = [...counts]
        .flatMap(([columnId, byValue]) => {
          const total = [...byValue.values()].reduce((a, b) => a + b, 0);
          return [...byValue].map(([text, n]) => ({ columnId, text, n, total, distinctValues: byValue.size }));
        })
        .sort((a, b) => b.total - a.total || a.columnId.localeCompare(b.columnId) || b.n - a.n);
      const info = new Map(VALUE_COLUMNS.map((col) => [columnIdOf(col), { title: col.title, type: "text", board: BOARD }]));
      const mappedAs = new Map(
        VALUE_COLUMNS.flatMap((col) => (col.mapped ? [[columnIdOf(col), [col.mapped]] as [string, string[]]] : [])),
      );
      const columns = rt.tools.summariseValueMatches(countRows, examples, info, mappedAs, limit);
      return ok({
        query: input.text,
        ...(input.columnHint ? { columnHint: input.columnHint, columnIds } : {}),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        columns,
        note:
          columns.length === 0
            ? "No active style carries this text. Try a shorter fragment, or drop columnHint / customerId."
            : "Values are the full text from the database (screenshots truncate). styles = active styles with a matching value in that column.",
      });
    },

    find_layouts: async () =>
      ok({
        scope: { customerId: CUSTOMER_ID, fromRequest: true, prodSpecs: 1 },
        thisOutputLayoutId: layout.id,
        layouts: [
          { ...layoutRow, thisOutput: true, usage: { prodSpecs: 1, styles: c.styles.length, prodSpecNames: ["Sample ProdSpec"] } },
        ],
      }),

    get_layout: async (raw) => {
      const input = raw as GetLayoutInput;
      if (input.layoutId !== layout.id) return fail(`Layout ${input.layoutId} not found. find_layouts lists the layouts in use.`);
      const draft = currentDraft();
      const showDraft = draft !== null && !input.live;
      return ok({
        layout: layoutRow,
        showing: showDraft ? "draft" : "live",
        openDraft: draft ? { revisionId: draft.id, number: draft.number, note: draft.note } : null,
        ...(draft ? { draftChanges: describeLayoutChanges(live, draft.definition).map((ch) => ch.summary) } : {}),
        ...rt.tools.summariseLayoutDef(showDraft && draft ? draft.definition : live),
      });
    },

    list_tokens: async (raw) => {
      const input = raw as ListTokensInput;
      const tokens = rt.gap.tokenCatalogue(input.query).filter((t) => !removed.has(t.key));
      const styleId = input.styleId ?? rep.id;
      const resolved = await resolvedFor(styleId);
      const keys = new Set(tokens.map((t) => t.key));
      const narrowed =
        resolved && input.query?.trim()
          ? { ...resolved, values: resolved.values.filter((v) => keys.has(v.key)), empty: resolved.empty.filter((k) => keys.has(k)) }
          : resolved;
      return ok({
        ...(input.query ? { query: input.query } : {}),
        count: tokens.length,
        tokens,
        resolved: narrowed,
        ...(!resolved ? { resolvedError: `Style ${styleId} not found.` } : {}),
        syntax: SYNTAX_NOTES,
      });
    },

    propose_patch: async (raw) => {
      const input = raw as ProposePatchInput;
      if (input.layoutId !== layout.id) {
        return fail(
          `This output ("${c.request.outputLabel}") prints from layout ${layout.id}; only that layout can be drafted in this run. ` +
            "If the change belongs on another output, say so with ask_reviewer.",
          { layoutId: layout.id },
        );
      }
      // Like production: refine this output's current draft when it has one.
      const parent = currentDraft();
      const baseKind = parent ? "draft" : "live";
      const preRejected: { op: LayoutOp; reason: string }[] = [];
      const allowed: LayoutOp[] = [];
      for (const op of input.ops) {
        const why = hiddenTokenError(op);
        if (why) preRejected.push({ op, reason: why });
        else allowed.push(op);
      }
      const result = applyLayoutOps(parent?.definition ?? live, allowed);
      const rejected = [...preRejected, ...result.rejected];
      if (result.applied.length === 0) {
        return fail("No op could be applied, so no draft was made. Fix the ops below and try again.", {
          base: baseKind,
          rejected,
          warnings: result.warnings,
        });
      }
      const number = state.drafts.length + 1;
      const draft: FixtureDraft = {
        id: `bench-rev-${number}`,
        number,
        parentId: parent?.id ?? null,
        definition: result.def,
        ops: [...(parent?.ops ?? []), ...result.applied],
        warnings: result.warnings,
        note: input.note,
      };
      state.drafts.push(draft);
      return ok({
        revisionId: draft.id,
        number,
        layoutId: layout.id,
        base: baseKind,
        parentRevisionId: parent?.id ?? null,
        applied: result.applied,
        rejected,
        warnings: result.warnings,
        changes: describeLayoutChanges(live, draft.definition).map((ch) => ch.summary),
        next: "render_proof this revision on the request's style and on one style it must not affect, then impact_list.",
      });
    },

    render_proof: async (raw) => {
      const input = raw as RenderProofInput;
      const sides: ("before" | "after")[] = !input.side || input.side === "both" ? ["before", "after"] : [input.side];
      const s = styleById(input.styleId);
      const label = s?.label ?? input.styleId;
      const draft = draftById(input.revisionId);
      const pics: ToolImage[] = [];
      const rendered: Record<string, unknown>[] = [];
      const text: Record<string, string[]> = {};
      let unavailable: string | null = null;
      for (const side of sides) {
        try {
          if (!draft) throw new rt.proofs.ProofNotFoundError("revision", "Revision not found");
          if (!s) throw new rt.proofs.ProofNotFoundError("style", `Style ${input.styleId} not found`);
          const docs = await renderFixtureDocs(c, side === "after" ? draft.definition : live, s.id);
          const { picked, unavailable: why } = await pictureOf(rt, docs, {
            ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
            scale,
            images,
          });
          const doc = picked.suffix ?? `doc ${picked.doc + 1}`;
          const caption = `${side} · ${label} · ${doc} · ${round(picked.widthMm, 1)}×${round(picked.heightMm, 1)} mm`;
          rendered.push({ side, caption, doc: picked.doc, suffix: picked.suffix, widthMm: picked.widthMm, heightMm: picked.heightMm });
          if (picked.png) {
            pics.push({ mediaType: "image/png", base64: picked.png.toString("base64"), caption });
          } else {
            unavailable ??= why ?? "no picture";
            text[side] = htmlTextSummary(picked.html, 1);
          }
        } catch (err) {
          return fail(`Could not render the ${side} proof: ${errorText(err)}`, {
            revisionId: input.revisionId,
            styleId: input.styleId,
          });
        }
      }
      const content = { revisionId: input.revisionId, styleId: input.styleId, style: label, images: rendered };
      if (unavailable === null) return ok(content, pics);
      return ok({
        ...content,
        picturesUnavailable: `${unavailable} — a text reading of each rendered document (first page) follows`,
        text,
      });
    },

    impact_list: async (raw) => {
      const input = raw as ImpactListInput;
      const draft = draftById(input.revisionId);
      if (!draft) return fail("Could not compute the impact: Revision not found", { revisionId: input.revisionId });
      const started = Date.now();
      const impact = await fixtureImpact(c, draft.definition);
      const changed = impact.docRows.filter((r) => r.changed);
      const changedStyles = new Set(changed.map((r) => r.styleId));
      const controls = [
        ...new Map(impact.docRows.filter((r) => !changedStyles.has(r.styleId)).map((r) => [r.styleId, r])).values(),
      ].slice(0, 5);
      return ok({
        revisionId: input.revisionId,
        counts: rt.impact.summarise(impact.docRows, c.styles.length),
        changed: changed.slice(0, 30).map((r) => ({
          styleId: r.styleId,
          style: r.styleLabel,
          poNumber: r.poNumber,
          variantKey: r.variantKey,
          reviewStatus: r.reviewStatus,
        })),
        ...(changed.length > 30 ? { changedNotShown: changed.length - 30 } : {}),
        unchangedControls: controls.map((r) => ({ styleId: r.styleId, style: r.styleLabel, poNumber: r.poNumber })),
        errors: impact.errors.slice(0, 10),
        durationMs: Date.now() - started,
      });
    },

    declare_gap: async (raw) => {
      const input = raw as GapDeclaration;
      const existing = removed.has(input.tokenKey) ? null : tokenMeta(input.tokenKey);
      if (existing) {
        return fail(
          `{{${input.tokenKey}}} already exists ("${existing.label}"), so this is not a code gap. ` +
            "Use it in the layout (list_tokens shows its value per style), with a conditional if it should only print sometimes.",
          { token: rt.gap.tokenCatalogue().find((t) => t.key === existing.key) ?? { key: existing.key } },
        );
      }
      capture("declare_gap", input);
      return ok({
        ok: true,
        status: "NEEDS_CODE",
        awaitingToken: input.tokenKey,
        buildPromptUrl: rt.gap.buildPromptPath("bench-request", OUTPUT_ID),
        email: { status: "SIMULATED", recipients: 1 },
        next: "Stop here: the output waits for the developer and is resumed automatically once the variable is deployed.",
      });
    },

    ask_reviewer: async (raw) => {
      const input = raw as AskReviewerInput;
      capture("ask_reviewer", input);
      return ok({
        ok: true,
        messageId: `bench-message-${++messages}`,
        to: input.to,
        status: input.to === "requester" ? "NEEDS_INFO" : "IN_REVIEW",
      });
    },

    propose_memory: async (raw) => {
      const input = raw as ProposeMemoryInput;
      let scopeRef = input.scopeRef ?? null;
      if (!scopeRef && input.scope === "CUSTOMER") scopeRef = CUSTOMER_ID;
      if (!scopeRef && input.scope === "DOC_TYPE") scopeRef = layout.docType;
      state.memories.push({ scope: input.scope, scopeRef, text: input.text, sourceKind: input.sourceKind });
      return ok({ ok: true, memoryId: `bench-memory-${state.memories.length}`, scope: input.scope, scopeRef, state: "PROPOSED" });
    },

    finish: async (raw) => {
      const input = raw as FinishInput;
      capture("finish", input);
      return ok({ ok: true, summary: input.summary });
    },
  };

  const tools = AGENT_TOOL_NAMES.map((name): AgentTool => {
    const production = rt.tools.toolByName(name);
    if (!production) throw new Error(`agent/tools.ts has no tool "${name}"`);
    const run = runs[name];
    return {
      name: production.name,
      description: production.description,
      input: production.input,
      // Like production's defineTool: a throw becomes an error result.
      run: async (input, ctx) => {
        try {
          return await run(input, ctx);
        } catch (err) {
          return fail(errorText(err));
        }
      },
    };
  });
  return { tools, state };
}
