// =====================================================
// Change-request bench — the agent's tools, served from a case file.
//
// fixtureTools(benchCase) implements every tool in AGENT_TOOL_NAMES over one
// frozen case instead of the database, so the bench runs the PRODUCTION loop
// (runAgentLoop) with the production prompt against the real model, and the
// only thing swapped out is where the tools read from:
//
//   get_request / find_layouts / get_layout     the case's request and layout
//   find_styles_by_value / list_tokens          the case's styles, as StyleData
//                                               (sample data + overrides), read
//                                               through the production resolvers
//   propose_patch                               applyLayoutOps in memory; drafts
//                                               live in `state`, never anywhere else
//   render_proof / impact_list                  renderLayoutHtml (production mode)
//                                               on the fixture StyleData, both sides
//   declare_gap / ask_reviewer / propose_memory captured in `state`; nothing is
//   / finish                                    sent or stored
//
// `removeTokens` hides tokens as if they did not exist yet: list_tokens leaves
// them out, propose_patch refuses lines that use them (with the same reason
// the publish gate gives for an unknown variable) and declare_gap accepts them
// as new. That is how a case asks "does the agent stop and hand over instead of
// faking it?".
//
// Rendering differs from production in one deliberate way. impact.ts compares
// normalised HTML, and a block whose every line resolves to nothing for a style
// still emits an empty wrapper — so production flags every style as changed as
// soon as a draft adds a conditional block, even where it prints nothing. The
// bench compares what PRINTS (inkHtml: empty, unframed, uninverted blocks
// dropped), because the control-style check is the point of several cases.
//
// No database: the renderer is loaded lazily, after the offline stand-in
// (offline-db.ts) is installed, so importing this module never constructs a
// Prisma client. Proof pictures need a browser (PUPPETEER_EXECUTABLE_PATH or
// Puppeteer's own); without one, render_proof answers with a text reading of
// the rendered HTML and says the images are unavailable.
// =====================================================

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { StyleData } from "@/lib/pdf/types";
import { LayoutOpSchema, applyLayoutOps, describeLayoutChanges, type LayoutOp } from "@/lib/output-layouts/ops";
import { layoutSettings, pageGrid, type LayoutDef } from "@/lib/output-layouts/schema";
import {
  BARCODE_SOURCES,
  CERT_SOURCES,
  LAYOUT_TOKENS,
  LOGO_SOURCES,
  tokenMeta,
  type LayoutTokenMeta,
} from "@/lib/output-layouts/token-meta";
import type { AgentTool, AgentToolName, ToolImage, ToolResult } from "../agent/contract";
import { AGENT_TOOL_NAMES } from "../agent/contract";
import { GapDeclarationSchema, MemoryScopeSchema, requestRef, type ImpactRow } from "../types";
import { STYLE_TEXT_FIELDS, benchStyleData, representativeStyle, type BenchCase, type BenchStyle } from "./case-schema";
import { installOfflineDatabase, registerOfflineWashSymbols } from "./offline-db";
import { lineTokenKeys, type BenchOutcome } from "./score";

// ── State ────────────────────────────────────────────────────────────────────

export type FixtureDraft = {
  id: string;
  parentId: string | null;
  // The live definition plus `ops`.
  definition: LayoutDef;
  ops: LayoutOp[];
  warnings: string[];
  note?: string;
};

export type FixtureState = {
  drafts: FixtureDraft[];
  // The first hand-off that succeeded (finish / declare_gap / ask_reviewer).
  terminal?: { name: AgentToolName; input: unknown };
  memories: { scope: string; text: string; scopeRef?: string }[];
};

export type FixtureToolsOptions = {
  // "auto" (default): PNG proofs when a browser launches, text otherwise.
  // "off": always text — tests, or a run that should not spend image tokens.
  images?: "auto" | "off";
  // Device pixels per CSS pixel for proofs; production proofs use 3.
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

// ── Runtime (lazy: renderer, resolvers, impact core, browser) ───────────────

type Runtime = {
  renderLayoutHtml: typeof import("@/lib/output-layouts/render").renderLayoutHtml;
  resolveTextToken: typeof import("@/lib/output-layouts/tokens").resolveTextToken;
  normaliseHtml: typeof import("../impact").normaliseHtml;
  summarise: typeof import("../impact").summarise;
  renderHtmlPng: typeof import("@/lib/pdf/renderer").renderHtmlPng;
};

let runtime: Promise<Runtime> | null = null;

// Installs the offline database stand-in (unless a real client already
// exists), then loads the render stack. Safe to call repeatedly; new wash
// symbol codes are registered on every call.
export async function loadBenchRuntime(washCodes: readonly string[] = []): Promise<Runtime> {
  installOfflineDatabase();
  runtime ??= (async () => {
    const symbols = await import("@/lib/pdf/washcare-symbols");
    registerOfflineWashSymbols(symbols.STANDARD_WASHCARE_SYMBOLS);
    const [render, tokens, impact, renderer] = await Promise.all([
      import("@/lib/output-layouts/render"),
      import("@/lib/output-layouts/tokens"),
      import("../impact"),
      import("@/lib/pdf/renderer"),
    ]);
    return {
      renderLayoutHtml: render.renderLayoutHtml,
      resolveTextToken: tokens.resolveTextToken,
      normaliseHtml: impact.normaliseHtml,
      summarise: impact.summarise,
      renderHtmlPng: renderer.renderHtmlPng,
    };
  })();
  const rt = await runtime;
  registerOfflineWashSymbols(washCodes.map((code) => ({ code })));
  return rt;
}

function caseWashCodes(c: BenchCase): string[] {
  return [...new Set(c.styles.flatMap((s) => benchStyleData(c, s.id).washSymbols))];
}

// ── The first message ────────────────────────────────────────────────────────

// The production first message (job.ts buildFirstMessage) for this case, built
// from what job.ts would have loaded from the database: the request, its one
// output and the screenshots. job.ts is imported only after the offline
// database is in place.
export async function benchFirstMessage(
  c: BenchCase,
  imagePaths: readonly string[] = [],
): Promise<{ content: Anthropic.Beta.BetaContentBlockParam[]; images: number }> {
  await loadBenchRuntime();
  const { buildFirstMessage } = await import("../agent/job");
  type Input = Parameters<typeof buildFirstMessage>[0];
  const rep = representativeStyle(c);
  const output = {
    id: "bench-output",
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

// ── Rendering helpers ────────────────────────────────────────────────────────

export type RenderedFixtureDoc = { html: string; widthMm: number; heightMm: number };

export async function renderFixtureDoc(c: BenchCase, def: LayoutDef, styleId: string): Promise<RenderedFixtureDoc> {
  const rt = await loadBenchRuntime(caseWashCodes(c));
  const html = await rt.renderLayoutHtml(def, benchStyleData(c, styleId), { mode: "production", title: c.layout.name });
  const page = def.pages[0];
  return { html, widthMm: page.widthMm, heightMm: page.heightMm };
}

// A block that prints nothing for this style: no ink in its lines, and no
// border or inverted background that would print regardless.
const BLOCK_RE = /<div class="(ol-block[^"]*)" style="([^"]*)">((?:<div class="ol-line">(?:&nbsp;|\s)*<\/div>)*)<\/div>/g;

// The comparable form of a rendered document: impact.ts's normalisation, then
// blocks that print nothing removed (see the header).
export function inkHtml(html: string, normalise: (h: string) => string): string {
  return normalise(html).replace(BLOCK_RE, (whole, cls: string, style: string) =>
    cls.includes("ol-binvert") || /(^|[;\s])border(-[a-z]+)?:/.test(style) || /background:/.test(style) ? whole : "",
  );
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

// Per style: does `proposed` change what prints, against the case's layout?
export type FixtureImpact = {
  rows: { styleId: string; styleLabel: string; group?: BenchStyle["group"]; changed: boolean }[];
  errors: { styleId: string; message: string }[];
};

export async function fixtureImpact(c: BenchCase, proposed: LayoutDef): Promise<FixtureImpact> {
  const rt = await loadBenchRuntime(caseWashCodes(c));
  const rows: FixtureImpact["rows"] = [];
  const errors: FixtureImpact["errors"] = [];
  for (const s of c.styles) {
    try {
      const [before, after] = await Promise.all([
        renderFixtureDoc(c, c.layout.definition, s.id),
        renderFixtureDoc(c, proposed, s.id),
      ]);
      rows.push({
        styleId: s.id,
        styleLabel: s.label,
        ...(s.group ? { group: s.group } : {}),
        changed: inkHtml(before.html, rt.normaliseHtml) !== inkHtml(after.html, rt.normaliseHtml),
      });
    } catch (err) {
      errors.push({ styleId: s.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, errors };
}

// ── Proof pictures ───────────────────────────────────────────────────────────

let browser: { ok: true } | { ok: false; reason: string } | null = null;

async function picture(doc: RenderedFixtureDoc, scale: number): Promise<{ png: Buffer } | { unavailable: string }> {
  if (browser && !browser.ok) return { unavailable: browser.reason };
  const rt = await loadBenchRuntime();
  try {
    const png = await rt.renderHtmlPng({ html: doc.html, widthMm: doc.widthMm, heightMm: doc.heightMm, scale });
    browser = { ok: true };
    return { png };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
    // The first failure is almost always "no browser here": stop trying.
    if (!browser) browser = { ok: false, reason };
    return { unavailable: reason };
  }
}

// ── The tools ────────────────────────────────────────────────────────────────

const COLUMN_TITLES: Record<string, string> = {
  styleName: "Style name",
  styleNumber: "Style number",
  customerName: "Customer",
  trimsRaw: "Trims",
  productGroup: "Product group",
  styleCommentsRaw: "Style comments",
  cartonQtyRaw: "Qty per carton",
  sizeRatioRaw: "Size ratio",
  customerItemNo: "Customer item no",
  customerItemNoRaw: "Customer item no",
  description: "Description",
  poNumber: "PO number",
  customerOrderNo: "Customer order no",
  countryOfOrigin: "Country of origin",
  campaignWeek: "Campaign week",
  batchNo: "Batch no",
  prodNumber: "Prod number",
  deliveryTerm: "Delivery term",
  compositionColour: "Composition colour",
};

// The searchable "Monday columns" of a fixture style: its text fields plus
// the composite ones (composition per language, wash symbols, sizes, price).
function styleColumns(style: StyleData): { id: string; title: string; value: string }[] {
  const cols: { id: string; title: string; value: string }[] = [];
  const loose = style as unknown as Record<string, unknown>;
  for (const key of STYLE_TEXT_FIELDS) {
    const v = loose[key];
    if (typeof v === "string" && v.trim()) cols.push({ id: key, title: COLUMN_TITLES[key] ?? key, value: v });
  }
  if (style.colour?.name) cols.push({ id: "colour", title: "Colour", value: style.colour.name });
  for (const c of style.composition) cols.push({ id: `composition:${c.language}`, title: `Composition (${c.language})`, value: c.text });
  if (style.washSymbols.length) cols.push({ id: "washSymbols", title: "Wash symbols", value: style.washSymbols.join(", ") });
  if (style.sizes.length) cols.push({ id: "sizes", title: "Sizes", value: style.sizes.map((s) => s.label).join(", ") });
  if (style.price) cols.push({ id: "price", title: "Retail price", value: String(style.price.amount) });
  return cols;
}

const SOURCES: Record<string, readonly string[]> = { barcode: BARCODE_SOURCES, logo: LOGO_SOURCES, cert: CERT_SOURCES };
// Per-language tokens whose value is on StyleData already; the others come
// from the translation bank at render time.
const SYNC_LANG_TOKENS = new Set(["composition", "compositionLines", "compositionMixes", "productName"]);

function errorResult(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: { error: message, ...extra }, isError: true };
}

export function fixtureTools(benchCase: BenchCase, opts: FixtureToolsOptions = {}): FixtureTools {
  const c = benchCase;
  const images = opts.images ?? "auto";
  const scale = opts.proofScale ?? 3;
  const state: FixtureState = { drafts: [], memories: [] };
  const removed = new Set(c.removeTokens ?? []);
  const rep = representativeStyle(c);
  const layout = c.layout;
  const live = layout.definition;

  const visibleTokens = (): LayoutTokenMeta[] => LAYOUT_TOKENS.filter((t) => !removed.has(t.key));
  const tokenExists = (key: string) => !removed.has(key) && tokenMeta(key) !== null;
  const styleById = (id: string) => c.styles.find((s) => s.id === id);
  const styleIds = () => c.styles.map((s) => s.id);
  const findDraft = (id: string | undefined) => (id ? state.drafts.find((d) => d.id === id) : state.drafts[state.drafts.length - 1]);
  const draftIds = () => state.drafts.map((d) => d.id);
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

  const tools: Record<AgentToolName, AgentTool> = {
    get_request: defineTool({
      name: "get_request",
      description:
        "Read the change request this run works on: the message as written, the output (print document) this run is about, its issue text, its layout id and the representative style to use for proofs.",
      input: z.object({}),
      run: async () => ({
        content: {
          request: { ref: requestRef(0), title: c.title, message: c.request.message, screenshots: c.images?.length ?? 0 },
          output: {
            label: c.request.outputLabel,
            issue: c.request.text,
            layoutId: layout.id,
            variantKey: `layout:${layout.id}`,
            representativeStyleId: rep.id,
            representativeStyleLabel: rep.label,
          },
        },
      }),
    }),

    find_styles_by_value: defineTool({
      name: "find_styles_by_value",
      description:
        "Search the styles' Monday data for a text value (case-insensitive substring) and get the full value of every column that contains it, with the column, style, customer and PO. Use it when a screenshot shows a truncated value or you need to know how a field is filled across styles.",
      input: z.object({
        query: z.string().min(2).describe("Text to look for, e.g. 'Solid polybag'"),
        limit: z.number().int().min(1).max(50).optional().describe("Max matches (default 20)"),
      }),
      run: async (input) => {
        const q = input.query.trim().toLowerCase();
        const matches: Record<string, unknown>[] = [];
        for (const s of c.styles) {
          const data = benchStyleData(c, s.id);
          for (const col of styleColumns(data)) {
            if (!col.value.toLowerCase().includes(q)) continue;
            matches.push({
              styleId: s.id,
              styleLabel: s.label,
              styleNumber: data.styleNumber,
              column: { id: col.id, title: col.title },
              value: col.value,
              customer: data.customerName,
              poNumber: data.poNumber ?? null,
            });
          }
        }
        const limit = input.limit ?? 20;
        return { content: { query: input.query, total: matches.length, matches: matches.slice(0, limit) } };
      },
    }),

    find_layouts: defineTool({
      name: "find_layouts",
      description:
        "Find the layouts (print designs) that could be the output in question, by customer, document type or name. Returns each layout's id, name, document type, page size and how many styles print it.",
      input: z.object({
        customer: z.string().optional(),
        docType: z.string().optional().describe("Document type, e.g. 'polybag sticker'"),
        query: z.string().optional().describe("Words from the layout name"),
      }),
      run: async () => {
        const p = live.pages[0];
        return {
          content: {
            layouts: [
              {
                id: layout.id,
                name: layout.name,
                docType: layout.docType,
                pages: live.pages.length,
                sizeMm: `${p.widthMm}×${p.heightMm}`,
                styles: c.styles.length,
                pickedForThisOutput: true,
              },
            ],
          },
        };
      },
    }),

    get_layout: defineTool({
      name: "get_layout",
      description:
        "Read a layout definition: its pages (size in mm, placement grid, margins) and every block with its id, rect on the grid {col,row,colSpan,rowSpan}, font and alignment, and text lines. Page and line indexes are 0-based — the same positions propose_patch takes. Pass draftId to read one of your drafts instead of the live layout.",
      input: z.object({
        layoutId: z.string(),
        draftId: z.string().optional().describe("Read this draft of yours instead of the live definition"),
      }),
      run: async (input) => {
        if (input.layoutId !== layout.id) return errorResult(`No layout "${input.layoutId}"`, { available: [layout.id] });
        let def = live;
        if (input.draftId) {
          const d = findDraft(input.draftId);
          if (!d) return errorResult(`No draft "${input.draftId}"`, { drafts: draftIds() });
          def = d.definition;
        }
        const settings = layoutSettings(def);
        return {
          content: {
            id: layout.id,
            name: layout.name,
            docType: layout.docType,
            source: input.draftId ? `draft ${input.draftId}` : "live",
            settings: { repeatBy: settings.repeatBy, splitBy: settings.splitBy },
            pages: def.pages.map((page, index) => {
              const { cols, rows } = pageGrid(page);
              const m = page.margins;
              return {
                page: index,
                id: page.id,
                title: page.title,
                widthMm: page.widthMm,
                heightMm: page.heightMm,
                grid: {
                  cols,
                  rows,
                  cellWidthMm: round2((page.widthMm - m.leftMm - m.rightMm) / cols),
                  cellHeightMm: round2((page.heightMm - m.topMm - m.bottomMm) / rows),
                },
                margins: m,
                blocks: page.blocks.map((b) => ({
                  id: b.id,
                  rect: b.rect,
                  fontPt: b.fontPt,
                  bold: b.bold,
                  align: b.align ?? "left",
                  valign: b.valign ?? "top",
                  lineHeight: b.lineHeight,
                  ...(b.fitWidth ? { fitWidth: true } : {}),
                  ...(b.fitHeight ? { fitHeight: true } : {}),
                  ...(b.invert ? { invert: true } : {}),
                  ...(b.border ? { border: b.border } : {}),
                  lines: b.lines,
                })),
              };
            }),
          },
        };
      },
    }),

    list_tokens: defineTool({
      name: "list_tokens",
      description:
        "List the variables ({{tokens}}) a layout line can use, with what each resolves to for a style (default: the request's representative style). Per-language tokens show a value per language the style has; graphics (barcode, symbols, logos) show their arguments. Only these tokens exist.",
      input: z.object({
        styleId: z.string().optional(),
        query: z.string().optional().describe("Only tokens whose key or label contains this"),
      }),
      run: async (input) => {
        const styleId = input.styleId ?? rep.id;
        const s = styleById(styleId);
        if (!s) return errorResult(`No style "${styleId}"`, { styles: styleIds() });
        const rt = await loadBenchRuntime(caseWashCodes(c));
        const data = benchStyleData(c, s.id);
        const q = input.query?.trim().toLowerCase();
        const langs = [...new Set([...data.composition, ...data.productNameTranslations].map((t) => t.language.toLowerCase()))];
        const tokens = visibleTokens()
          .filter((t) => !q || t.key.toLowerCase().includes(q) || t.label.toLowerCase().includes(q))
          .map((t) => {
            const entry: Record<string, unknown> = { key: t.key, label: t.label, kind: t.kind, group: t.group };
            if (t.arg) entry.arg = t.arg;
            if (t.example) entry.example = t.example;
            if (t.kind === "text" && t.arg === "lang") {
              if (SYNC_LANG_TOKENS.has(t.key)) {
                entry.values = Object.fromEntries(langs.map((l) => [l, rt.resolveTextToken(data, t.key, l)]).filter(([, v]) => v));
              } else {
                entry.values = "resolved from the translation bank when the document renders";
              }
            } else if (t.kind === "text" || t.key === "washSymbols") {
              entry.value = rt.resolveTextToken(data, t.key);
            }
            if (SOURCES[t.key]) entry.sources = SOURCES[t.key];
            return entry;
          });
        return { content: { styleId: s.id, styleLabel: s.label, count: tokens.length, tokens } };
      },
    }),

    propose_patch: defineTool({
      name: "propose_patch",
      description:
        "Draft a layout change as a list of operations on the live layout (or on one of your drafts with parentDraftId). The draft never prints; it is what the reviewer approves. Each op is checked on its own: rejected ops come back with a reason and the rest still apply. Returns the draft id, applied/rejected ops, warnings (likely overlap or overflow — check them in the proof) and a plain summary of the change.",
      input: z.object({
        layoutId: z.string(),
        ops: z.array(LayoutOpSchema).min(1),
        parentDraftId: z.string().optional().describe("Apply the ops on top of this draft instead of the live layout"),
        note: z.string().optional().describe("One line on what this draft does"),
      }),
      run: async (input) => {
        if (input.layoutId !== layout.id) return errorResult(`No layout "${input.layoutId}"`, { available: [layout.id] });
        const parent = input.parentDraftId ? findDraft(input.parentDraftId) : undefined;
        if (input.parentDraftId && !parent) return errorResult(`No draft "${input.parentDraftId}"`, { drafts: draftIds() });

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
          return errorResult("No op could be applied, so no draft was made.", { rejected });
        }
        const draft: FixtureDraft = {
          id: `d${state.drafts.length + 1}`,
          parentId: parent?.id ?? null,
          definition: result.def,
          ops: [...(parent?.ops ?? []), ...result.applied],
          warnings: result.warnings,
          ...(input.note ? { note: input.note } : {}),
        };
        state.drafts.push(draft);
        return {
          content: {
            draftId: draft.id,
            ...(parent ? { parentDraftId: parent.id } : {}),
            applied: result.applied,
            rejected,
            warnings: result.warnings,
            changes: describeLayoutChanges(live, draft.definition).map((ch) => ch.summary),
          },
        };
      },
    }),

    render_proof: defineTool({
      name: "render_proof",
      description:
        "Render a draft as the printed document for one style — before (live layout) and after (your draft) — and look at the pictures: is the fix there, does anything overlap or overflow, is a style the change must not affect unchanged? Defaults to your newest draft.",
      input: z.object({
        styleId: z.string(),
        draftId: z.string().optional(),
        side: z.enum(["before", "after", "both"]).default("both"),
      }),
      run: async (input) => {
        const s = styleById(input.styleId);
        if (!s) return errorResult(`No style "${input.styleId}"`, { styles: styleIds() });
        const draft = findDraft(input.draftId);
        if (input.draftId && !draft) return errorResult(`No draft "${input.draftId}"`, { drafts: draftIds() });
        const sides: ("before" | "after")[] = input.side === "both" ? ["before", "after"] : [input.side];
        const notes: string[] = [];
        if (!draft && sides.includes("after")) {
          notes.push("No draft yet — showing the live layout only.");
          sides.splice(sides.indexOf("after"), 1);
          if (!sides.length) sides.push("before");
        }
        const docs = await Promise.all(
          sides.map(async (side) => ({
            side,
            doc: await renderFixtureDoc(c, side === "after" && draft ? draft.definition : live, s.id),
          })),
        );
        const base = {
          styleId: s.id,
          styleLabel: s.label,
          ...(draft ? { draftId: draft.id } : {}),
          sizeMm: `${docs[0].doc.widthMm}×${docs[0].doc.heightMm}`,
          ...(notes.length ? { notes } : {}),
        };
        let unavailable: string | null = images === "off" ? "proof pictures are switched off for this run" : null;
        const pics: ToolImage[] = [];
        if (!unavailable) {
          for (const { side, doc } of docs) {
            const pic = await picture(doc, scale);
            if ("unavailable" in pic) {
              unavailable = pic.unavailable;
              break;
            }
            pics.push({
              mediaType: "image/png",
              base64: pic.png.toString("base64"),
              caption: `${side} · ${s.label}${side === "after" && draft ? ` · draft ${draft.id}` : ""}`,
            });
          }
        }
        if (unavailable === null) return { content: { ...base, sides }, images: pics };
        return {
          content: {
            ...base,
            images: `unavailable (${unavailable}) — a text reading of the rendered document follows`,
            // The first page, like the picture would be.
            text: Object.fromEntries(docs.map(({ side, doc }) => [side, htmlTextSummary(doc.html, 1)])),
          },
        };
      },
    }),

    impact_list: defineTool({
      name: "impact_list",
      description:
        "Work out which documents a draft changes: every style that prints this layout is rendered with the live layout and with the draft, and the printed results compared. Defaults to your newest draft. Use it to make sure the change reaches the styles the request is about and no others.",
      input: z.object({ draftId: z.string().optional() }),
      run: async (input) => {
        const draft = findDraft(input.draftId);
        if (!draft) {
          return errorResult(input.draftId ? `No draft "${input.draftId}"` : "No draft yet — propose_patch first", {
            drafts: draftIds(),
          });
        }
        const rt = await loadBenchRuntime(caseWashCodes(c));
        const impact = await fixtureImpact(c, draft.definition);
        const rows: ImpactRow[] = impact.rows.map((r) => ({
          styleId: r.styleId,
          styleLabel: r.styleLabel,
          poNumber: benchStyleData(c, r.styleId).poNumber ?? null,
          variantKey: `layout:${layout.id}`,
          changed: r.changed,
          reviewStatus: "NONE",
          uploaded: false,
          emailed: false,
          inFlight: false,
        }));
        return {
          content: {
            draftId: draft.id,
            counts: rt.summarise(rows, c.styles.length),
            changed: rows.filter((r) => r.changed),
            unchanged: rows.filter((r) => !r.changed).map((r) => ({ styleId: r.styleId, styleLabel: r.styleLabel })),
            ...(impact.errors.length ? { errors: impact.errors } : {}),
          },
        };
      },
    }),

    declare_gap: defineTool({
      name: "declare_gap",
      description:
        "Hand the request to a developer because no existing token can express what it needs. Name the new token, where its value comes from on Monday (board, column, the real values with how often each occurs), the rule in plain words and worked input → output cases. This ends the run; the request resumes when the token is live. Refused if the token already exists.",
      input: GapDeclarationSchema,
      run: async (input) => {
        if (tokenExists(input.tokenKey)) {
          return errorResult(`{{${input.tokenKey}}} already exists — use it (see list_tokens) instead of declaring a gap.`);
        }
        capture("declare_gap", input);
        return { content: { ok: true, status: "NEEDS_CODE", awaitingToken: input.tokenKey } };
      },
    }),

    ask_reviewer: defineTool({
      name: "ask_reviewer",
      description:
        "Ask the reviewer one clear question when two readings of the request are plausible and would lead to different changes. List the options you see. This ends the run; it resumes with their answer.",
      input: z.object({
        question: z.string().min(1),
        options: z.array(z.string()).optional(),
      }),
      run: async (input) => {
        capture("ask_reviewer", input);
        return { content: { ok: true, status: "NEEDS_INFO" } };
      },
    }),

    propose_memory: defineTool({
      name: "propose_memory",
      description:
        "Suggest a short note for future runs (a customer's convention, how a field is used) after a reviewer corrected you. A person keeps or dismisses it.",
      input: z.object({
        scope: MemoryScopeSchema,
        text: z.string().min(1).max(1000),
        scopeRef: z.string().optional().describe("Customer id, document type, … for a scoped note"),
      }),
      run: async (input) => {
        state.memories.push({ scope: input.scope, text: input.text, ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}) });
        return { content: { ok: true, state: "PROPOSED" } };
      },
    }),

    finish: defineTool({
      name: "finish",
      description:
        "Hand your newest draft to the reviewer with a short plain-language summary: what was wrong, what you changed, which styles you checked and anything they should look at. This ends the run.",
      input: z.object({ summary: z.string().min(1) }),
      run: async (input) => {
        capture("finish", input);
        const last = findDraft(undefined);
        return { content: { ok: true, draftId: last?.id ?? null } };
      },
    }),
  };

  return { tools: AGENT_TOOL_NAMES.map((name) => tools[name]), state };
}

// The tool's input type flows from its schema into run(); the list itself is
// typed loosely, as the loop parses every input with the tool's schema first.
function defineTool<I extends z.ZodType>(tool: AgentTool<I>): AgentTool {
  return tool as unknown as AgentTool;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
