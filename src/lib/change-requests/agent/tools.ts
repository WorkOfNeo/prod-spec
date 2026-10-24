import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_COLUMN_MAPPING, parseCustomerConfig } from "@/lib/customers/config";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { applyLayoutOps, describeLayoutChanges, LayoutOpSchema } from "@/lib/output-layouts/ops";
import { createDraft, getRevision, reviseDraft } from "@/lib/output-layouts/revisions";
import { layoutSettings, pageGrid, parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import {
  isLayoutVariantKey,
  layoutIdFromVariantKey,
  layoutVariantKey,
} from "@/lib/output-layouts/variant-keys";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { orEmpty } from "../db-safe";
import type { ProofSide } from "../proofs";
import {
  appendMessage,
  createProposedMemory,
  getOutputWithRequest,
  getRequestDetail,
  setOutputStatus,
} from "../store";
import {
  GapDeclarationSchema,
  MemoryScopeSchema,
  MemorySourceKindSchema,
  requestRef,
  type RevisionStatus,
} from "../types";
import type { AgentTool, ToolContext, ToolResult } from "./contract";

// =====================================================
// Change-request agent — tool implementations.
//
// The ONE list of tools the agent can call, implementing the contract in
// contract.ts (names fixed by AGENT_TOOL_NAMES). Both callers use this list
// unchanged: agent/job.ts (the in-app tool-use loop) and scripts/cr-tools.ts
// (the Claude Code trial), so the trial exercises exactly what ships.
//
// RAILS (design §2). Read + draft only:
//   • nothing here publishes, reruns, deletes, emails a supplier or touches
//     SharePoint. The only writes are a DRAFT revision (propose_patch, which
//     also points the output at it), thread messages, the output's status for
//     a hand-off (declare_gap → NEEDS_CODE, ask_reviewer → NEEDS_INFO /
//     IN_REVIEW), a PROPOSED memory note, and the developer email inside
//     declare_gap (internal, never a supplier);
//   • propose_patch drafts only on the output's own layout, so a run can't
//     wander into a layout nobody asked about.
//
// Results are plain JSON for the model. A refusal or a failure comes back as
// an error result with a reason the model can act on ("this block id doesn't
// exist", "that variable already exists") rather than a thrown error, so the
// loop can let it correct itself. Every tool also logs one domain step through
// ctx.log (read / draft / proof / impact / gap / question / memory / finish);
// the loop logs the mechanical `tool:<name>` row (input, duration) itself.
//
// The render-heavy modules (proofs → Chromium, impact → the render pipeline,
// gap → translations + email) are imported when a tool first needs them, so
// the routes that only START a run (and import the job, hence this list)
// don't load them.
// =====================================================

// ── Helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function ok(content: Json | unknown[] | string, images?: ToolResult["images"]): ToolResult {
  return images && images.length > 0 ? { content, images } : { content };
}

function fail(error: string, extra: Json = {}): ToolResult {
  return { isError: true, content: { error, ...extra } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The audit trail must never break the tool it records.
async function note(ctx: ToolContext, kind: string, summary: string, detail?: Json): Promise<void> {
  try {
    await ctx.log({ kind, summary, ...(detail ? { detail } : {}) });
  } catch (err) {
    console.warn(`[change-requests] tool log failed: ${errorText(err)}`);
  }
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// AgentTool is contravariant in its input; the list holds the erased form.
// Unexpected throws become error results so every caller (loop, CLI, tests)
// sees the same shape.
function defineTool<I extends z.ZodType>(tool: AgentTool<I>): AgentTool {
  const run = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: ToolContext) => {
      try {
        return await run(input as z.infer<I>, ctx);
      } catch (err) {
        return fail(errorText(err));
      }
    },
  } as AgentTool;
}

async function thisOutput(ctx: ToolContext) {
  return ctx.outputId ? getOutputWithRequest(ctx.outputId) : null;
}

// The layout an output prints from: its recorded layoutId, else the one its
// variant key names. null when it has none yet (or prints a coded template).
function outputLayoutId(output: { layoutId: string | null; variantKey: string | null }): string | null {
  return output.layoutId ?? layoutIdFromVariantKey(output.variantKey);
}

// The output's open draft, when it is a DRAFT on `layoutId`.
async function openDraftOn(output: { currentRevisionId: string | null } | null, layoutId: string) {
  if (!output?.currentRevisionId) return null;
  const rev = await getRevision(output.currentRevisionId);
  if (!rev || rev.layoutId !== layoutId || rev.status !== ("DRAFT" satisfies RevisionStatus)) return null;
  return rev;
}

// ── get_request ──────────────────────────────────────────────────────────────

const THREAD_LIMIT = 30;
const MESSAGE_MAX = 2000;

const getRequest = defineTool({
  name: "get_request",
  description:
    "Read the change request this run works on: the request (number, title, the requester's message as written, PO, customer, picked style), " +
    "THIS output (label, issue text, variantKey, layoutId, representative styleId, status, current draft), the review thread (last 30 messages, " +
    "this output's and request-wide) and the attachment file names. The screenshots themselves were already given to you in the first message. " +
    "Call it first, and again after a reviewer comment to re-read the thread.",
  input: z.object({}),
  run: async (_input, ctx) => {
    if (!ctx.requestId) return fail("This run is not attached to a request.");
    const detail = await getRequestDetail(ctx.requestId);
    if (!detail) return fail(`Request ${ctx.requestId} not found.`);
    const output = ctx.outputId ? (detail.outputs.find((o) => o.id === ctx.outputId) ?? null) : null;
    if (ctx.outputId && !output) return fail(`Output ${ctx.outputId} is not part of request ${requestRef(detail.number)}.`);

    const styleId = output?.styleId ?? detail.styleId;
    const [customer, style, draft] = await Promise.all([
      detail.customerId
        ? db.customer.findUnique({ where: { id: detail.customerId }, select: { id: true, name: true } })
        : Promise.resolve(null),
      styleId
        ? db.style.findUnique({ where: { id: styleId }, select: { id: true, name: true, poNumber: true } })
        : Promise.resolve(null),
      output?.currentRevisionId ? getRevision(output.currentRevisionId) : Promise.resolve(null),
    ]);
    const inScope = (outputId: string | null) => !ctx.outputId || outputId === null || outputId === ctx.outputId;
    const thread = detail.messages
      .filter((m) => inScope(m.outputId))
      .slice(-THREAD_LIMIT)
      .map((m) => ({
        at: m.createdAt.toISOString(),
        author: m.authorKind,
        kind: m.kind,
        body: clip(m.body, MESSAGE_MAX),
        ...(m.revisionId ? { revisionId: m.revisionId } : {}),
      }));

    await note(ctx, "read", `Read ${requestRef(detail.number)}${output ? ` · ${output.label}` : ""}`);
    return ok({
      request: {
        ref: requestRef(detail.number),
        number: detail.number,
        title: detail.title,
        status: detail.status,
        message: detail.message,
        poNumber: detail.poNumber,
        customer: customer ?? (detail.customerId ? { id: detail.customerId, name: null } : null),
        styleId: detail.styleId,
      },
      output: output
        ? {
            id: output.id,
            label: output.label,
            text: output.text,
            variantKey: output.variantKey,
            layoutId: outputLayoutId(output),
            styleId: output.styleId,
            status: output.status,
            currentRevisionId: output.currentRevisionId,
            draftCount: output.draftCount,
            ...(output.awaitingToken ? { awaitingToken: output.awaitingToken } : {}),
          }
        : null,
      style: style ? { id: style.id, label: style.name, poNumber: style.poNumber } : null,
      currentDraft: draft
        ? { revisionId: draft.id, number: draft.number, status: draft.status, layoutId: draft.layoutId, note: draft.note }
        : null,
      otherOutputs: detail.outputs.filter((o) => o.id !== output?.id).map((o) => ({ label: o.label, status: o.status })),
      thread,
      attachments: detail.attachments
        .filter((a) => inScope(a.outputId))
        .map((a) => ({ fileName: a.fileName, ...(a.outputId ? { outputId: a.outputId } : {}) })),
    });
  },
});

// ── find_styles_by_value ─────────────────────────────────────────────────────

const VALUE_COLUMNS_DEFAULT = 8;
const VALUE_COLUMNS_MAX = 25;
const EXAMPLES_PER_COLUMN = 5;
const VALUES_PER_COLUMN = 5;
const VALUE_ROWS_MAX = 400;
const MATCH_TEXT_MAX = 2000;

export type ValueCountRow = { columnId: string; text: string; n: number; total: number; distinctValues: number };
export type ValueExampleRow = {
  styleId: string;
  label: string;
  poNumber: string | null;
  customer: string | null;
  mondayBoardId: string;
  columnId: string;
  text: string;
};
export type ColumnInfo = { title: string | null; type: string | null; board: { id: string; name: string } | null };

export type ValueMatchColumn = {
  columnId: string;
  title: string | null;
  type: string | null;
  board: { id: string; name: string } | null;
  // StyleData fields that read this column by default ("trims", "cartonQty").
  mappedAs: string[];
  styles: number;
  distinctValues: number;
  values: { text: string; count: number }[];
  examples: { styleId: string; label: string; poNumber: string | null; customer: string | null; text: string }[];
};

// Escape LIKE wildcards so the agent's text matches literally.
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Pure: the two query results grouped per column, biggest first.
export function summariseValueMatches(
  counts: readonly ValueCountRow[],
  examples: readonly ValueExampleRow[],
  info: ReadonlyMap<string, ColumnInfo>,
  mappedAs: ReadonlyMap<string, string[]>,
  limit: number,
): ValueMatchColumn[] {
  const byColumn = new Map<string, ValueMatchColumn>();
  for (const r of counts) {
    let col = byColumn.get(r.columnId);
    if (!col) {
      const i = info.get(r.columnId);
      col = {
        columnId: r.columnId,
        title: i?.title ?? null,
        type: i?.type ?? null,
        board: i?.board ?? null,
        mappedAs: mappedAs.get(r.columnId) ?? [],
        styles: Number(r.total),
        distinctValues: Number(r.distinctValues),
        values: [],
        examples: [],
      };
      byColumn.set(r.columnId, col);
    }
    if (col.values.length < VALUES_PER_COLUMN) col.values.push({ text: clip(r.text, MATCH_TEXT_MAX), count: Number(r.n) });
  }
  for (const e of examples) {
    const col = byColumn.get(e.columnId);
    if (!col || col.examples.length >= EXAMPLES_PER_COLUMN) continue;
    col.examples.push({
      styleId: e.styleId,
      label: e.label,
      poNumber: e.poNumber,
      customer: e.customer,
      text: clip(e.text, MATCH_TEXT_MAX),
    });
  }
  return [...byColumn.values()]
    .sort((a, b) => b.styles - a.styles || a.columnId.localeCompare(b.columnId))
    .slice(0, limit);
}

function fieldsByColumn(...mappings: Array<Record<string, unknown> | null | undefined>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of mappings) {
    if (!m) continue;
    for (const [field, col] of Object.entries(m)) {
      if (typeof col !== "string" || !col) continue;
      const list = out.get(col) ?? [];
      if (!list.includes(field)) list.push(field);
      out.set(col, list);
    }
  }
  return out;
}

const findStylesByValue = defineTool({
  name: "find_styles_by_value",
  description:
    "Search the Monday data of every active style for a text value and see which column holds it. Screenshots truncate and abbreviate; " +
    "the database has the full value, so use this to turn a fragment you can read in a screenshot (\"5 Pcs / Polybag\", a size, an order " +
    "number) into: the column id and title, the board, how many styles carry it, the most common full values with counts, and up to 5 example " +
    "styles per column (style id, label, PO, customer, full text). Case-insensitive substring match. Narrow with columnHint (a column id, " +
    "part of a column title, or a mapped field name such as \"trims\") and customerId. Use it before deciding a value is missing, and to get the " +
    "real distribution you quote in declare_gap.",
  input: z.object({
    text: z.string().trim().min(2).max(200).describe("The value or fragment to look for, as it appears in the data."),
    columnHint: z.string().trim().min(1).max(120).optional().describe("Column id, part of a column title, or a mapped field name."),
    customerId: z.string().min(1).optional().describe("Only styles of this customer."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(VALUE_COLUMNS_MAX)
      .optional()
      .describe(`Max columns to return (default ${VALUE_COLUMNS_DEFAULT}).`),
  }),
  run: async (input, ctx) => {
    const limit = input.limit ?? VALUE_COLUMNS_DEFAULT;
    const [globalConfig, customer] = await Promise.all([
      orEmpty(
        db.mondayColumnConfig.findUnique({ where: { id: "global" }, select: { columnMapping: true, requiredFields: true } }),
        null,
      ),
      input.customerId
        ? db.customer.findUnique({ where: { id: input.customerId }, select: { config: true } })
        : Promise.resolve(null),
    ]);
    let customerMapping: Record<string, unknown> | null = null;
    if (customer) {
      try {
        customerMapping = parseCustomerConfig(customer.config).columnMapping;
      } catch {
        customerMapping = null;
      }
    }
    const rawGlobal = globalConfig?.columnMapping;
    const globalMapping =
      rawGlobal && typeof rawGlobal === "object" && !Array.isArray(rawGlobal) ? (rawGlobal as Record<string, unknown>) : null;
    const mapping: Record<string, unknown> = customerMapping ?? DEFAULT_COLUMN_MAPPING;
    const mappedAs = fieldsByColumn(mapping, globalMapping);

    // columnHint → column ids: the hint itself, a mapped field of that name,
    // and every mirrored column whose id or title matches.
    let columnIds: string[] | null = null;
    if (input.columnHint) {
      const hint = input.columnHint;
      const ids = new Set<string>([hint]);
      const mappedCol = mapping[hint];
      if (typeof mappedCol === "string" && mappedCol) ids.add(mappedCol);
      const ghost = await orEmpty(
        db.mondayGhostColumn.findMany({
          where: { OR: [{ mondayColumnId: hint }, { title: { contains: hint, mode: "insensitive" } }] },
          select: { mondayColumnId: true },
          take: 50,
        }),
        [] as { mondayColumnId: string }[],
      );
      for (const g of ghost) ids.add(g.mondayColumnId);
      columnIds = [...ids];
    }

    const filters: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
      Prisma.sql`s."archivedAt" IS NULL`,
      Prisma.sql`v.val ILIKE ${likePattern(input.text)}`,
    ];
    if (input.customerId) filters.push(Prisma.sql`s."customerId" = ${input.customerId}`);
    if (columnIds) filters.push(Prisma.sql`cv->>'id' = ANY(${columnIds}::text[])`);
    // Mirror columns carry their value in display_value with an empty text.
    const hits = Prisma.sql`
      SELECT s.id, s.name, s."poNumber", s."customerId", s."mondayBoardId", s."updatedAt",
             cv->>'id' AS col, v.val
        FROM styles s
       CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s."rawData"->'column_values') = 'array'
                    THEN s."rawData"->'column_values' ELSE '[]'::jsonb END) cv
       CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(cv->>'text', ''), cv->>'display_value') AS val) v
       WHERE ${Prisma.join(filters, " AND ")}`;

    const [counts, examples] = await Promise.all([
      db.$queryRaw<ValueCountRow[]>(Prisma.sql`
        WITH hits AS (${hits})
        SELECT g.col AS "columnId", g.val AS text, g.n,
               (sum(g.n) OVER (PARTITION BY g.col))::int AS total,
               (count(*) OVER (PARTITION BY g.col))::int AS "distinctValues"
          FROM (SELECT col, val, count(*)::int AS n FROM hits GROUP BY col, val) g
         ORDER BY total DESC, g.col, g.n DESC
         LIMIT ${VALUE_ROWS_MAX}`),
      db.$queryRaw<ValueExampleRow[]>(Prisma.sql`
        WITH hits AS (${hits})
        SELECT r.id AS "styleId", r.name AS label, r."poNumber", c.name AS customer,
               r."mondayBoardId", r.col AS "columnId", r.val AS text
          FROM (SELECT h.*, row_number() OVER (PARTITION BY h.col ORDER BY h."updatedAt" DESC, h.id) AS rn
                  FROM hits h) r
          LEFT JOIN customers c ON c.id = r."customerId"
         WHERE r.rn <= ${EXAMPLES_PER_COLUMN}`),
    ]);

    // Titles and boards from the Monday mirror, preferring the board the
    // examples live on; the shared column config's labels as a fallback.
    const ids = [...new Set(counts.map((c) => c.columnId))];
    const ghost =
      ids.length > 0
        ? await orEmpty(
            db.mondayGhostColumn.findMany({
              where: { mondayColumnId: { in: ids } },
              select: {
                mondayColumnId: true,
                title: true,
                type: true,
                board: { select: { mondayBoardId: true, name: true, label: true } },
              },
            }),
            [],
          )
        : [];
    const boardsOf = new Map<string, Set<string>>();
    for (const e of examples) {
      const set = boardsOf.get(e.columnId) ?? new Set<string>();
      set.add(e.mondayBoardId);
      boardsOf.set(e.columnId, set);
    }
    const requiredLabels = new Map<string, string>();
    const rawRequired = globalConfig?.requiredFields;
    if (Array.isArray(rawRequired)) {
      for (const f of rawRequired as unknown[]) {
        const r = (f ?? {}) as { id?: unknown; label?: unknown };
        if (typeof r.id === "string" && typeof r.label === "string") requiredLabels.set(r.id, r.label);
      }
    }
    const info = new Map<string, ColumnInfo>();
    for (const id of ids) {
      const candidates = ghost.filter((g) => g.mondayColumnId === id);
      const onBoard = boardsOf.get(id);
      const best = candidates.find((g) => onBoard?.has(g.board.mondayBoardId)) ?? candidates[0];
      info.set(id, {
        title: best?.title ?? requiredLabels.get(id) ?? null,
        type: best?.type ?? null,
        board: best ? { id: best.board.mondayBoardId, name: best.board.label || best.board.name } : null,
      });
    }

    const columns = summariseValueMatches(counts, examples, info, mappedAs, limit);
    const totalStyles = columns.reduce((n, c) => n + c.styles, 0);
    await note(
      ctx,
      "read",
      `Value search ${JSON.stringify(clip(input.text, 60))}: ${plural(columns.length, "column")}, ` +
        `${totalStyles} ${totalStyles === 1 ? "match" : "matches"}`,
    );
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
});

// ── find_layouts ─────────────────────────────────────────────────────────────

const LAYOUTS_MAX = 30;

const findLayouts = defineTool({
  name: "find_layouts",
  description:
    "List the Output Builder layouts that print for a customer or ProdSpec (enabled outputs whose key is layout:<id>), with id, name, doc type, " +
    "status, version and usage counts (ProdSpecs and active styles). This output's own layout is listed first and marked thisOutput. With no " +
    "customerId / prodSpecId it searches the request's customer. Filter with docType (e.g. STICKER, CARTON_MARKING) and nameContains. Use it " +
    "to confirm which layout the issue is about before get_layout.",
  input: z.object({
    customerId: z.string().min(1).optional(),
    prodSpecId: z.string().min(1).optional(),
    docType: z.string().min(1).max(60).optional(),
    nameContains: z.string().min(1).max(120).optional(),
  }),
  run: async (input, ctx) => {
    const output = await thisOutput(ctx);
    const ownLayoutId = output ? outputLayoutId(output) : null;
    const requestCustomerId = output?.request.customerId ?? null;
    let customerId = input.customerId ?? null;
    let defaulted = false;
    if (!input.prodSpecId && !customerId && requestCustomerId) {
      customerId = requestCustomerId;
      defaulted = true;
    }

    const specs = await db.prodSpec.findMany({
      where: input.prodSpecId ? { id: input.prodSpecId } : customerId ? { customerId } : {},
      select: { id: true, name: true, outputs: true },
      orderBy: { name: "asc" },
    });
    const usage = new Map<string, { specIds: string[]; specNames: string[] }>();
    for (const spec of specs) {
      let outputs;
      try {
        outputs = parseProdSpecOutputs(spec.outputs);
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const o of outputs) {
        if (o.enabled === false) continue;
        const id = layoutIdFromVariantKey(baseVariantKey(o.variantKey));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const u = usage.get(id) ?? { specIds: [], specNames: [] };
        u.specIds.push(spec.id);
        u.specNames.push(spec.name);
        usage.set(id, u);
      }
    }

    const specIds = specs.map((s) => s.id);
    const styleCounts =
      specIds.length > 0
        ? await db.style.groupBy({
            by: ["prodSpecId"],
            where: { prodSpecId: { in: specIds }, archivedAt: null, deletedAt: null },
            _count: { _all: true },
          })
        : [];
    const stylesBySpec = new Map(styleCounts.map((r) => [r.prodSpecId, r._count._all]));

    const ids = [...new Set([...usage.keys(), ...(ownLayoutId ? [ownLayoutId] : [])])];
    const layoutSelect = { id: true, name: true, docType: true, status: true, version: true } as const;
    const [used, named] = await Promise.all([
      ids.length > 0 ? db.outputLayout.findMany({ where: { id: { in: ids } }, select: layoutSelect }) : Promise.resolve([]),
      // By name, layouts not (yet) printing there show up too.
      input.nameContains
        ? db.outputLayout.findMany({
            where: { name: { contains: input.nameContains, mode: "insensitive" } },
            select: layoutSelect,
            take: LAYOUTS_MAX,
          })
        : Promise.resolve([]),
    ]);
    const rows = new Map([...named, ...used].map((l) => [l.id, l]));

    const docType = input.docType?.toLowerCase();
    const nameContains = input.nameContains?.toLowerCase();
    const layouts = [...rows.values()]
      .map((l) => {
        const u = usage.get(l.id);
        return {
          id: l.id,
          name: l.name,
          docType: l.docType,
          status: l.status,
          version: l.version,
          thisOutput: l.id === ownLayoutId,
          usage: {
            prodSpecs: u?.specIds.length ?? 0,
            styles: (u?.specIds ?? []).reduce((n, id) => n + (stylesBySpec.get(id) ?? 0), 0),
            prodSpecNames: (u?.specNames ?? []).slice(0, 5),
          },
        };
      })
      .filter(
        (l) =>
          l.thisOutput ||
          ((!docType || l.docType.toLowerCase() === docType) &&
            (!nameContains || l.name.toLowerCase().includes(nameContains))),
      )
      .sort(
        (a, b) =>
          Number(b.thisOutput) - Number(a.thisOutput) || b.usage.styles - a.usage.styles || a.name.localeCompare(b.name),
      )
      .slice(0, LAYOUTS_MAX);

    await note(ctx, "read", `Layouts: ${layouts.length} found${ownLayoutId ? " (this output's first)" : ""}`);
    return ok({
      scope: {
        ...(input.prodSpecId ? { prodSpecId: input.prodSpecId } : {}),
        ...(customerId ? { customerId, ...(defaulted ? { fromRequest: true } : {}) } : {}),
        prodSpecs: specs.length,
      },
      thisOutputLayoutId: ownLayoutId,
      layouts,
    });
  },
});

// ── get_layout ───────────────────────────────────────────────────────────────

// The definition in the units the agent reasons in: block ids, grid rects and
// the same rects in mm, so "27 × 4 cells" and "13.5 × 2 mm" are both visible.
export function summariseLayoutDef(def: LayoutDef) {
  const s = layoutSettings(def);
  return {
    settings: {
      repeatBy: s.repeatBy,
      splitBy: s.splitBy,
      splitByComposition: s.splitByComposition,
      fileName: s.fileName,
      cartonNumbering: s.cartonNumbering,
      multipleStyles: s.multipleStyles,
      generationRules: s.rules.length,
    },
    pages: def.pages.map((page, index) => {
      const grid = pageGrid(page);
      const cellW = page.widthMm / grid.cols;
      const cellH = page.heightMm / grid.rows;
      return {
        page: index,
        id: page.id,
        title: page.title,
        widthMm: page.widthMm,
        heightMm: page.heightMm,
        grid,
        cellMm: { width: round(cellW), height: round(cellH) },
        blocks: page.blocks.map((b) => ({
          id: b.id ?? null,
          ...(b.rect
            ? {
                rect: b.rect,
                mm: {
                  x: round(b.rect.col * cellW),
                  y: round(b.rect.row * cellH),
                  width: round(b.rect.colSpan * cellW),
                  height: round(b.rect.rowSpan * cellH),
                },
              }
            : { anchor: b.anchor ?? null, cols: b.cols }),
          fontPt: b.fontPt,
          bold: b.bold,
          align: b.align ?? "left",
          valign: b.valign ?? "top",
          fitWidth: b.fitWidth,
          fitHeight: b.fitHeight,
          lineHeight: b.lineHeight,
          ...(b.invert ? { invert: true } : {}),
          ...(b.border ? { border: { widthMm: b.border.widthMm, color: b.border.color } } : {}),
          lines: b.lines,
        })),
      };
    }),
  };
}

const getLayout = defineTool({
  name: "get_layout",
  description:
    "Read one layout definition: settings (repeatBy, splitBy, …) and per page its size in mm, grid (cols × rows) and cell size in mm, then every " +
    "block with its id, rect (grid cells) and the same rect in mm, fontPt, bold, align/valign, fitWidth/fitHeight, lineHeight and its lines " +
    "(with {{tokens}} and conditionals). page and line numbers are 0-based, as propose_patch expects. When this output already has an open " +
    "draft on the layout, you get the DRAFT's definition (what propose_patch builds on) plus what it changes against the live layout; pass " +
    "live: true to see the live definition instead.",
  input: z.object({
    layoutId: z.string().min(1),
    live: z.boolean().optional().describe("Show the live definition even when this output has an open draft."),
  }),
  run: async (input, ctx) => {
    const layout = await db.outputLayout.findUnique({
      where: { id: input.layoutId },
      select: { id: true, name: true, docType: true, status: true, version: true, definition: true },
    });
    if (!layout) return fail(`Layout ${input.layoutId} not found. find_layouts lists the layouts in use.`);
    const output = await thisOutput(ctx);
    const draft = await openDraftOn(output, layout.id);

    let live: LayoutDef;
    try {
      live = parseLayoutDef(layout.definition);
    } catch (err) {
      return fail(`The live definition of "${layout.name}" does not parse: ${errorText(err)}`);
    }
    const draftDef = draft ? parseLayoutDef(draft.definition) : null;
    const showDraft = draftDef !== null && !input.live;

    await note(ctx, "read", `Layout "${layout.name}" v${layout.version}${showDraft && draft ? ` (draft #${draft.number})` : ""}`);
    return ok({
      layout: { id: layout.id, name: layout.name, docType: layout.docType, status: layout.status, version: layout.version },
      showing: showDraft ? "draft" : "live",
      openDraft: draft ? { revisionId: draft.id, number: draft.number, note: draft.note } : null,
      ...(draftDef ? { draftChanges: describeLayoutChanges(live, draftDef).map((c) => c.summary) } : {}),
      ...summariseLayoutDef(showDraft && draftDef ? draftDef : live),
    });
  },
});

// ── list_tokens ──────────────────────────────────────────────────────────────

const SYNTAX_NOTES = [
  "A line holds text and variables: {{key}} or {{key:arg}} (no spaces inside the braces).",
  'Conditionals (one level): {{if field op "value"}}…{{else}}…{{endif}} with op == != contains !contains includes !includes. {{if key != ""}}…{{endif}} prints only when the variable has a value.',
  "Calculations: {{= expr }}.",
  "Sibling-style slots ({{style2}}, {{style3Name}}, …) exist for multi-style carton markings only.",
];

const listTokens = defineTool({
  name: "list_tokens",
  description:
    "List the layout variables ({{tokens}}) a layout line can use — key, label, group, kind, argument type and an example — optionally narrowed " +
    "by a free-text query (every word must match key, label, group or example). With a style (styleId, else this output's style) it also " +
    "returns what every text variable resolves to for that style, per language for the translated ones, and which resolve to empty. Use it to " +
    "find an existing variable before you conclude a value is missing; prefer an existing variable plus a conditional over anything else.",
  input: z.object({
    styleId: z.string().min(1).optional(),
    query: z.string().max(120).optional(),
  }),
  run: async (input, ctx) => {
    const { resolvedTokens, tokenCatalogue } = await import("../gap");
    const tokens = tokenCatalogue(input.query);
    let styleId = input.styleId ?? null;
    if (!styleId) {
      const output = await thisOutput(ctx);
      styleId = output?.styleId ?? output?.request.styleId ?? null;
    }
    const resolved = styleId ? await resolvedTokens(styleId) : null;
    const keys = new Set(tokens.map((t) => t.key));
    const narrowed =
      resolved && input.query?.trim()
        ? { ...resolved, values: resolved.values.filter((v) => keys.has(v.key)), empty: resolved.empty.filter((k) => keys.has(k)) }
        : resolved;

    await note(
      ctx,
      "read",
      `Tokens${input.query ? ` matching ${JSON.stringify(clip(input.query, 40))}` : ""}: ${tokens.length}` +
        (narrowed ? ` · resolved for ${narrowed.styleLabel}` : ""),
    );
    return ok({
      ...(input.query ? { query: input.query } : {}),
      count: tokens.length,
      tokens,
      resolved: narrowed,
      ...(styleId && !resolved ? { resolvedError: `Style ${styleId} not found.` } : {}),
      syntax: SYNTAX_NOTES,
    });
  },
});

// ── propose_patch ────────────────────────────────────────────────────────────

const OPS_MAX = 50;

const proposePatch = defineTool({
  name: "propose_patch",
  description:
    "Draft a change to THIS output's layout as a list of edit operations. Nothing prints differently: the result is a new DRAFT revision for a " +
    "person to review. The ops apply on top of this output's current draft when it has one (so you can refine it), else on the live layout. " +
    "Ops: add_block, remove_block, set_rect (move/resize, grid cells), set_block_props (fontPt, bold, align, valign, fitWidth, fitHeight, " +
    "lineHeight, invert, border), edit_line / remove_line (quote the current text as oldText), insert_line. page and line are 0-based; blocks are " +
    "addressed by id (get_layout). Each op is checked on its own: rejected ops come back with a reason and the rest still apply; warnings flag " +
    "likely overlap or overflow. Returns the revisionId and a plain list of what changed against the live layout. Then render_proof it on the " +
    "request's style and on one style it must not affect. Only this output's layout can be drafted.",
  input: z.object({
    layoutId: z.string().min(1),
    ops: z.array(LayoutOpSchema).min(1).max(OPS_MAX),
    note: z.string().trim().min(1).max(500).describe("One line for the reviewer: what this draft changes and why."),
  }),
  run: async (input, ctx) => {
    if (!ctx.outputId) return fail("propose_patch needs the output this run works on; this run has none.");
    const output = await getOutputWithRequest(ctx.outputId);
    if (!output) return fail(`Output ${ctx.outputId} not found.`);

    const ownLayoutId = outputLayoutId(output);
    if (ownLayoutId && ownLayoutId !== input.layoutId) {
      return fail(
        `This output ("${output.label}") prints from layout ${ownLayoutId}; only that layout can be drafted in this run. ` +
          "If the change belongs on another output, say so with ask_reviewer.",
        { layoutId: ownLayoutId },
      );
    }
    if (!ownLayoutId && output.variantKey && !isLayoutVariantKey(output.variantKey)) {
      return fail(
        `This output ("${output.label}") prints from a coded template (${output.variantKey}), not an Output Builder layout, so a layout draft ` +
          "cannot change it. Use ask_reviewer (or declare_gap when it needs new code).",
      );
    }

    const layout = await db.outputLayout.findUnique({
      where: { id: input.layoutId },
      select: { id: true, name: true, definition: true },
    });
    if (!layout) return fail(`Layout ${input.layoutId} not found.`);

    let live: LayoutDef;
    try {
      live = parseLayoutDef(layout.definition);
    } catch (err) {
      return fail(`The live definition of "${layout.name}" does not parse: ${errorText(err)}`);
    }
    const parent = await openDraftOn(output, layout.id);
    const base = parent ? parseLayoutDef(parent.definition) : live;

    const result = applyLayoutOps(base, input.ops);
    if (result.applied.length === 0) {
      await note(ctx, "draft", `No draft: all ${plural(result.rejected.length, "op")} rejected`);
      return fail("No op could be applied, so no draft was made. Fix the ops below and try again.", {
        base: parent ? "draft" : "live",
        rejected: result.rejected,
        warnings: result.warnings,
      });
    }

    const draftInput = {
      definition: result.def,
      authorKind: "AGENT" as const,
      authorUserId: null,
      changeRequestOutputId: output.id,
      ops: result.applied as unknown[],
      note: input.note,
    };
    const revision = parent
      ? await reviseDraft(parent.id, draftInput)
      : await createDraft({ ...draftInput, layoutId: layout.id });

    // The newest draft becomes the output's current one, so the next patch in
    // this run builds on it and impact_list caches against it. An output that
    // had no layout yet is pinned to this one. The job counts drafts per run
    // (draftCount) when it hands the result to review.
    await db.changeRequestOutput.update({
      where: { id: output.id },
      data: {
        currentRevisionId: revision.id,
        ...(ownLayoutId
          ? {}
          : { layoutId: layout.id, ...(output.variantKey ? {} : { variantKey: layoutVariantKey(layout.id) }) }),
      },
    });

    const changes = describeLayoutChanges(live, result.def).map((c) => c.summary);
    await note(
      ctx,
      "draft",
      `Draft #${revision.number} of "${layout.name}": ${plural(result.applied.length, "op")} applied` +
        (result.rejected.length ? `, ${result.rejected.length} rejected` : ""),
      { revisionId: revision.id, parentRevisionId: parent?.id ?? null, warnings: result.warnings.length },
    );
    return ok({
      revisionId: revision.id,
      number: revision.number,
      layoutId: layout.id,
      base: parent ? "draft" : "live",
      parentRevisionId: parent?.id ?? null,
      applied: result.applied.length,
      rejected: result.rejected,
      warnings: result.warnings,
      changes,
      next: "render_proof this revision on the request's style and on one style it must not affect, then impact_list.",
    });
  },
});

// ── render_proof ─────────────────────────────────────────────────────────────

const renderProofTool = defineTool({
  name: "render_proof",
  description:
    "Render a revision as PNG images for one style: \"before\" is the layout as it prints today, \"after\" the draft, both through the same " +
    "faithful per-output render the runner uses (pins, carton preference, size). Returns both sides by default, with captions and the page " +
    "size in mm. Look at them: check the change landed where the screenshot asked, nothing overflows or overlaps, text is at least 5 pt, and " +
    "that a style which must not change looks the same on both sides. For an output split into several files, pick one with suffix " +
    "(e.g. a size) — otherwise the first document is shown.",
  input: z.object({
    revisionId: z.string().min(1),
    styleId: z.string().min(1),
    side: z.enum(["before", "after", "both"]).optional(),
    suffix: z.string().min(1).max(200).optional().describe("Document of a split output (the part after # in its key)."),
  }),
  run: async (input, ctx) => {
    const { renderProof } = await import("../proofs");
    const sides: readonly ProofSide[] = !input.side || input.side === "both" ? ["before", "after"] : [input.side];
    const style = await db.style.findUnique({ where: { id: input.styleId }, select: { name: true } });
    const label = style?.name ?? input.styleId;
    const images: NonNullable<ToolResult["images"]> = [];
    const rendered: Json[] = [];
    for (const side of sides) {
      try {
        const proof = await renderProof({
          revisionId: input.revisionId,
          styleId: input.styleId,
          side,
          ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
        });
        const doc = proof.suffix ?? `doc ${proof.doc + 1}`;
        const caption = `${side} · ${label} · ${doc} · ${round(proof.widthMm, 1)}×${round(proof.heightMm, 1)} mm`;
        images.push({ mediaType: "image/png", base64: proof.png.toString("base64"), caption });
        rendered.push({ side, caption, doc: proof.doc, suffix: proof.suffix, widthMm: proof.widthMm, heightMm: proof.heightMm });
      } catch (err) {
        await note(ctx, "proof", `Proof ${side} failed for ${label}: ${errorText(err)}`);
        return fail(`Could not render the ${side} proof: ${errorText(err)}`, {
          revisionId: input.revisionId,
          styleId: input.styleId,
        });
      }
    }
    await note(ctx, "proof", `Proof ${sides.join(" + ")} · ${label}`, { revisionId: input.revisionId, styleId: input.styleId });
    return ok({ revisionId: input.revisionId, styleId: input.styleId, style: label, images: rendered }, images);
  },
});

// ── impact_list ──────────────────────────────────────────────────────────────

const IMPACT_ROWS_MAX = 30;
const IMPACT_CONTROLS_MAX = 5;
const IMPACT_ERRORS_MAX = 10;

const impactList = defineTool({
  name: "impact_list",
  description:
    "Work out exactly which documents a revision would change if it were published: every style that prints the layout is rendered with the " +
    "live and the draft definition and compared. Returns counts (styles, documents, changed, unchanged, changed by review status, already " +
    "approved, already delivered), up to 30 changed documents (style, PO, review status, uploaded/emailed, in flight), a few unchanged styles " +
    "you can use as a control for render_proof, and styles that could not be rendered. Run it after the proofs look right; a change that " +
    "touches far more documents than the request implies is a sign the draft is too broad.",
  input: z.object({ revisionId: z.string().min(1) }),
  run: async (input, ctx) => {
    const { impactForRevision } = await import("../impact");
    let summary;
    try {
      summary = await impactForRevision(input.revisionId);
    } catch (err) {
      return fail(`Could not compute the impact: ${errorText(err)}`, { revisionId: input.revisionId });
    }
    const changed = summary.rows.filter((r) => r.changed);
    const changedStyles = new Set(changed.map((r) => r.styleId));
    const controls = [
      ...new Map(summary.rows.filter((r) => !changedStyles.has(r.styleId)).map((r) => [r.styleId, r])).values(),
    ].slice(0, IMPACT_CONTROLS_MAX);
    const errors = summary.errors ?? [];

    await note(
      ctx,
      "impact",
      `Impact: ${summary.counts.changed} of ${plural(summary.counts.docs, "document")} change (${plural(summary.counts.styles, "style")})`,
      { revisionId: input.revisionId, changed: summary.counts.changed, docs: summary.counts.docs, errors: errors.length },
    );
    return ok({
      revisionId: input.revisionId,
      counts: summary.counts,
      changed: changed.slice(0, IMPACT_ROWS_MAX).map((r) => ({
        styleId: r.styleId,
        style: r.styleLabel,
        poNumber: r.poNumber,
        variantKey: r.variantKey,
        reviewStatus: r.reviewStatus,
        ...(r.uploaded ? { uploaded: true } : {}),
        ...(r.emailed ? { emailed: true } : {}),
        ...(r.inFlight ? { inFlight: true } : {}),
      })),
      ...(changed.length > IMPACT_ROWS_MAX ? { changedNotShown: changed.length - IMPACT_ROWS_MAX } : {}),
      unchangedControls: controls.map((r) => ({ styleId: r.styleId, style: r.styleLabel, poNumber: r.poNumber })),
      errors: errors.slice(0, IMPACT_ERRORS_MAX),
      ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    });
  },
});

// ── declare_gap ──────────────────────────────────────────────────────────────

const declareGapTool = defineTool({
  name: "declare_gap",
  description:
    "Hand the request to the developer when the change needs a value no existing variable can express (list_tokens has nothing that prints " +
    "it, and it can't be built from existing variables with a conditional). Give the new variable's key (camelCase), a label, where the value " +
    "lives on Monday (board, column, the real values you found with find_styles_by_value and their counts), the rule in plain words, and " +
    "worked input → output cases (an empty output means the variable prints nothing for that input). The output then waits as NEEDS_CODE " +
    "and the developer gets a build prompt; it resumes by itself once the variable is deployed. Refused if the key already exists — use that " +
    "variable instead. This ends your run.",
  input: GapDeclarationSchema,
  run: async (input, ctx) => {
    const { declareGap } = await import("../gap");
    return declareGap(ctx, input);
  },
});

// ── ask_reviewer ─────────────────────────────────────────────────────────────

const askReviewer = defineTool({
  name: "ask_reviewer",
  description:
    "Ask a person a question instead of guessing — when two readings of the request are plausible, the screenshot is unclear, or the change " +
    "seems to belong to another output. to: \"requester\" (the person who reported it; the output waits as NEEDS_INFO) or \"admin\" (the " +
    "reviewer; the output goes to review). Write one clear question with the options you see. This ends your run; it starts again when they answer.",
  input: z.object({
    question: z.string().trim().min(1).max(2000),
    to: z.enum(["admin", "requester"]),
  }),
  run: async (input, ctx) => {
    if (!ctx.requestId || !ctx.outputId) return fail("ask_reviewer needs the request and output this run works on.");
    const message = await appendMessage({
      requestId: ctx.requestId,
      outputId: ctx.outputId,
      authorKind: "AGENT",
      kind: "question",
      body: input.question,
      meta: { to: input.to },
    });
    const status = input.to === "requester" ? "NEEDS_INFO" : "IN_REVIEW";
    await setOutputStatus(ctx.outputId, status);
    await note(ctx, "question", `Asked the ${input.to}: ${clip(input.question.replace(/\s+/g, " "), 200)}`, { to: input.to });
    return ok({ ok: true, messageId: message.id, to: input.to, status });
  },
});

// ── propose_memory ───────────────────────────────────────────────────────────

const proposeMemory = defineTool({
  name: "propose_memory",
  description:
    "Suggest a short note for future runs, learned from this request or from a reviewer's correction (\"this customer wants quantities in " +
    "bold\"). A person keeps or dismisses it; only kept notes are ever read. scope: GLOBAL, CUSTOMER (scopeRef = customer id; defaults to the " +
    "request's customer), DOC_TYPE (scopeRef = doc type, e.g. STICKER; defaults to this output's layout doc type) or MONDAY (how the data " +
    "is written). sourceKind: CORRECTION (a reviewer corrected you), AGENT_FINDING or REQUEST. One fact per note, at most 3 per run.",
  input: z.object({
    scope: MemoryScopeSchema,
    scopeRef: z.string().min(1).max(120).optional(),
    text: z.string().trim().min(1).max(1000),
    sourceKind: MemorySourceKindSchema,
  }),
  run: async (input, ctx) => {
    if (!ctx.requestId) return fail("propose_memory needs the request this run works on.");
    let scopeRef = input.scopeRef ?? null;
    if (!scopeRef && (input.scope === "CUSTOMER" || input.scope === "DOC_TYPE")) {
      const output = await thisOutput(ctx);
      if (input.scope === "CUSTOMER") {
        scopeRef = output?.request.customerId ?? null;
      } else if (output) {
        const layoutId = outputLayoutId(output);
        const layout = layoutId
          ? await db.outputLayout.findUnique({ where: { id: layoutId }, select: { docType: true } })
          : null;
        scopeRef = layout?.docType ?? null;
      }
      if (!scopeRef) {
        return fail(`A ${input.scope} note needs scopeRef (the ${input.scope === "CUSTOMER" ? "customer id" : "doc type"}).`);
      }
    }
    const memory = await createProposedMemory({
      scope: input.scope,
      scopeRef,
      text: input.text,
      sourceKind: input.sourceKind,
      sourceRequestId: ctx.requestId,
    });
    await appendMessage({
      requestId: ctx.requestId,
      outputId: ctx.outputId,
      authorKind: "AGENT",
      kind: "memory_suggestion",
      body: input.text,
      meta: { memoryId: memory.id, scope: input.scope, scopeRef },
    });
    await note(ctx, "memory", `Suggested a ${input.scope.toLowerCase()} note: ${clip(input.text, 160)}`, { memoryId: memory.id });
    return ok({ ok: true, memoryId: memory.id, scope: input.scope, scopeRef, state: "PROPOSED" });
  },
});

// ── finish ───────────────────────────────────────────────────────────────────

const finish = defineTool({
  name: "finish",
  description:
    "End the run with a plain-language summary for the reviewer: what you changed and why, which styles you checked (including the one that " +
    "must not change), how many documents the impact list says would change, and anything they should look at. Call it after propose_patch, " +
    "render_proof and impact_list. If you made no draft, explain why instead.",
  input: z.object({ summary: z.string().trim().min(1).max(4000) }),
  run: async (input, ctx) => {
    await note(ctx, "finish", clip(input.summary.replace(/\s+/g, " "), 300));
    return ok({ ok: true, summary: input.summary });
  },
});

// ── The list ─────────────────────────────────────────────────────────────────

// In AGENT_TOOL_NAMES order; tests assert the two match one to one.
export const AGENT_TOOLS: AgentTool[] = [
  getRequest,
  findStylesByValue,
  findLayouts,
  getLayout,
  listTokens,
  proposePatch,
  renderProofTool,
  impactList,
  declareGapTool,
  askReviewer,
  proposeMemory,
  finish,
];

const BY_NAME = new Map<string, AgentTool>(AGENT_TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): AgentTool | undefined {
  return BY_NAME.get(name);
}
