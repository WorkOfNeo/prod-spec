import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_COLUMN_MAPPING, parseCustomerConfig } from "@/lib/customers/config";
import { ruleSentence, type DocTypeRulesMap } from "@/lib/outputs/exclusion";
import { ignoreBaseKey, loadStyleFieldValues } from "@/lib/outputs/output-field-values";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { loadStyleLineValues, splitLineValues } from "@/lib/outputs/output-line-values";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { parseFieldOverrides } from "@/lib/pdf/pins-meta";
import { parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { applyLayoutOps, describeLayoutChanges, LayoutOpSchema } from "@/lib/output-layouts/ops";
import { createDraft, definitionsEqual, getRevision, reviseDraft } from "@/lib/output-layouts/revisions";
import { layoutSettings, pageGrid, parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import { layoutOutputsInSpecs, prodSpecsUsingLayout } from "@/lib/output-layouts/usage";
import {
  isLayoutVariantKey,
  layoutIdFromVariantKey,
  layoutVariantKey,
} from "@/lib/output-layouts/variant-keys";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
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
  type MemorySourceKind,
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
//   • every write re-reads the output first and happens only while it is
//     WORKING — a run the stale sweep already failed, or an output a person
//     approved meanwhile, writes nothing;
//   • propose_patch drafts only on the output's own layout, so a run can't
//     wander into a layout nobody asked about; an output with no layout yet
//     can only be pinned to a layout the request's style actually prints;
//   • render_proof and impact_list only take this output's own drafts, and
//     the heavy and noisy tools have a per-run budget (RUN_LIMITS);
//   • the cover is printed by code: get_cover reads it, nothing drafts it;
//   • the settings around an output (the prod spec's output row, the layout's
//     Settings card, a style's review-tab values) are read by
//     get_output_settings, never written — a draft changes blocks and lines.
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

// ── Run guards ───────────────────────────────────────────────────────────────

// A tool that writes re-reads the output and refuses unless this run still
// holds it (WORKING): the sweep may have failed a slow run, or a person may
// have approved or rejected the output while the run was busy.
function notWorking(tool: string, status: string): ToolResult {
  return fail(
    `${tool} refused: this output is ${status} now, not WORKING. The run was stopped (the stale-run sweep failed it) ` +
      "or a person moved the output on meanwhile, so nothing was written. End the run.",
    { status },
  );
}

// Per-run limits on the heavy tools (every impact_list renders each style
// twice; every render_proof is two Chromium renders sent back as images) and
// on memory proposals. Keyed by the ToolContext object: the job makes one per
// run, so each run starts from zero; the CLI makes one per call.
export const RUN_LIMITS = { impact_list: 4, render_proof: 16, propose_memory: 3 } as const;
type LimitedTool = keyof typeof RUN_LIMITS;
const runUsage = new WeakMap<ToolContext, Record<LimitedTool, number>>();

function usageOf(ctx: ToolContext): Record<LimitedTool, number> {
  let used = runUsage.get(ctx);
  if (!used) {
    used = { impact_list: 0, render_proof: 0, propose_memory: 0 };
    runUsage.set(ctx, used);
  }
  return used;
}

function budgetSpent(ctx: ToolContext, tool: LimitedTool): ToolResult | null {
  if (usageOf(ctx)[tool] < RUN_LIMITS[tool]) return null;
  return fail(`${tool} can be called at most ${RUN_LIMITS[tool]} times per run, and this run has used them all.`, {
    limit: RUN_LIMITS[tool],
  });
}

function spendBudget(ctx: ToolContext, tool: LimitedTool): void {
  usageOf(ctx)[tool]++;
}

function refundBudget(ctx: ToolContext, tool: LimitedTool): void {
  const used = usageOf(ctx);
  used[tool] = Math.max(0, used[tool] - 1);
}

// render_proof / impact_list work on drafts made for THIS output only (their
// revision carries its changeRequestOutputId), never on an arbitrary revision
// of any layout.
async function ownRevision(ctx: ToolContext, revisionId: string, tool: string) {
  if (!ctx.outputId) return { error: fail(`${tool} needs the output this run works on; this run has none.`) };
  const revision = await getRevision(revisionId);
  if (!revision || revision.changeRequestOutputId !== ctx.outputId) {
    return {
      error: fail(
        `${tool} only works on drafts made for this output (propose_patch returns their revisionId); ${revisionId} is not one of them.`,
        { revisionId },
      ),
    };
  }
  return { revision };
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

// A draft made before the live layout last changed (a builder autosave or a
// publish since). Building on it would carry the OLD live content forward, and
// because a revised draft re-snapshots its base from today's layout, publishing
// it would silently undo that change — so the tools build on the live layout
// instead and say so.
function draftIsStale(
  draft: { baseDefinition: unknown; baseVersion: number },
  layout: { definition: unknown; version: number },
): boolean {
  return draft.baseVersion !== layout.version || !definitionsEqual(draft.baseDefinition, layout.definition);
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
    "styles per column (style id, label, PO, customer, full text). Case-insensitive substring match. Searches the request's customer unless " +
    "you pass another customerId; narrow further with columnHint (a column id, part of a column title, or a mapped field name such as " +
    "\"trims\"). Use it before deciding a value is missing, and to get the real distribution you quote in declare_gap.",
  input: z.object({
    text: z.string().trim().min(2).max(200).describe("The value or fragment to look for, as it appears in the data."),
    columnHint: z.string().trim().min(1).max(120).optional().describe("Column id, part of a column title, or a mapped field name."),
    customerId: z.string().min(1).optional().describe("Only styles of this customer (default: the request's customer)."),
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
    // The scan reads every active style's Monday JSON, so it stays on the
    // request's customer unless the agent names another one.
    let customerId = input.customerId ?? null;
    let customerFromRequest = false;
    if (!customerId) {
      customerId = (await thisOutput(ctx))?.request.customerId ?? null;
      customerFromRequest = customerId !== null;
    }
    const [globalConfig, customer] = await Promise.all([
      orEmpty(
        db.mondayColumnConfig.findUnique({ where: { id: "global" }, select: { columnMapping: true, requiredFields: true } }),
        null,
      ),
      customerId ? db.customer.findUnique({ where: { id: customerId }, select: { config: true } }) : Promise.resolve(null),
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
    if (customerId) filters.push(Prisma.sql`s."customerId" = ${customerId}`);
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

    // Both scans in one transaction with a statement timeout, so a broad
    // fragment over a large table gives up after 5 s instead of holding a
    // pooled connection for as long as it takes.
    const [counts, examples] = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      const countRows = await tx.$queryRaw<ValueCountRow[]>(Prisma.sql`
        WITH hits AS (${hits})
        SELECT g.col AS "columnId", g.val AS text, g.n,
               (sum(g.n) OVER (PARTITION BY g.col))::int AS total,
               (count(*) OVER (PARTITION BY g.col))::int AS "distinctValues"
          FROM (SELECT col, val, count(*)::int AS n FROM hits GROUP BY col, val) g
         ORDER BY total DESC, g.col, g.n DESC
         LIMIT ${VALUE_ROWS_MAX}`);
      const exampleRows = await tx.$queryRaw<ValueExampleRow[]>(Prisma.sql`
        WITH hits AS (${hits})
        SELECT r.id AS "styleId", r.name AS label, r."poNumber", c.name AS customer,
               r."mondayBoardId", r.col AS "columnId", r.val AS text
          FROM (SELECT h.*, row_number() OVER (PARTITION BY h.col ORDER BY h."updatedAt" DESC, h.id) AS rn
                  FROM hits h) r
          LEFT JOIN customers c ON c.id = r."customerId"
         WHERE r.rn <= ${EXAMPLES_PER_COLUMN}`);
      return [countRows, exampleRows] as const;
    });

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
    const scopeNote = customerFromRequest
      ? ` Only the request's customer (${customerId}) was searched; pass customerId to search another customer.`
      : "";
    return ok({
      query: input.text,
      ...(input.columnHint ? { columnHint: input.columnHint, columnIds } : {}),
      ...(customerId ? { customerId, ...(customerFromRequest ? { customerFromRequest: true } : {}) } : {}),
      columns,
      note:
        (columns.length === 0
          ? "No active style carries this text. Try a shorter fragment, or drop columnHint."
          : "Values are the full text from the database (screenshots truncate). styles = active styles with a matching value in that column.") +
        scopeNote,
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
    const stale = draft ? draftIsStale(draft, layout) : false;
    const draftDef = draft ? parseLayoutDef(draft.definition) : null;
    const showDraft = draftDef !== null && !stale && !input.live;

    await note(ctx, "read", `Layout "${layout.name}" v${layout.version}${showDraft && draft ? ` (draft #${draft.number})` : ""}`);
    return ok({
      layout: { id: layout.id, name: layout.name, docType: layout.docType, status: layout.status, version: layout.version },
      showing: showDraft ? "draft" : "live",
      openDraft: draft
        ? {
            revisionId: draft.id,
            number: draft.number,
            note: draft.note,
            ...(stale
              ? {
                  stale: true,
                  notice:
                    "The live layout changed after this draft was made, so propose_patch builds on the live layout shown here; " +
                    "include any of the draft's changes you still want.",
                }
              : {}),
          }
        : null,
      ...(draftDef && !stale ? { draftChanges: describeLayoutChanges(live, draftDef).map((c) => c.summary) } : {}),
      ...summariseLayoutDef(showDraft && draftDef ? draftDef : live),
    });
  },
});

// ── list_tokens ──────────────────────────────────────────────────────────────

// Exported for the bench (fixture-tools.ts), whose list_tokens must read the
// same as production's.
export const SYNTAX_NOTES = [
  "A line holds text and variables: {{key}} or {{key:arg}} (no spaces inside the braces).",
  'Conditionals (one level): {{if field op "value"}}…{{else}}…{{endif}} with op == != contains !contains includes !includes. {{if key != ""}}…{{endif}} prints only when the variable has a value.',
  "Calculations: {{= expr }}.",
  "Graphics take a source, not a key: {{barcode:<source>}}, {{logo:<source>}}, {{cert:<source>}} — each token's `sources` lists the only " +
    "sources the publish gate accepts (a source such as cartonEan13 is not a variable of its own). A barcode's optional bar height in mm " +
    "comes last: {{barcode:cartonEan13:12}}.",
  "Sibling-style slots ({{style2}}, {{style3Name}}, …) exist for multi-style carton markings only.",
];

const listTokens = defineTool({
  name: "list_tokens",
  description:
    "List the layout variables ({{tokens}}) a layout line can use — key, label, group, kind, argument type and an example; for the graphics " +
    "tokens (barcode, logo, cert) also every source they accept with what it prints, e.g. {{barcode:cartonEan13}} draws the carton EAN as a " +
    "true EAN-13 — optionally narrowed by a free-text query (every word must match key, label, group, example or a source). With a style " +
    "(styleId, else this output's style) it also returns what every text variable resolves to for that style, per language for the translated " +
    "ones, which resolve to empty, and what each barcode source would encode and in which symbology for this output. Use it to find an " +
    "existing variable or source before you conclude a value is missing; prefer an existing variable plus a conditional over anything else.",
  input: z.object({
    styleId: z.string().min(1).optional(),
    query: z.string().max(120).optional(),
  }),
  run: async (input, ctx) => {
    const { resolvedTokens, tokenCatalogue } = await import("../gap");
    const tokens = tokenCatalogue(input.query);
    const output = await thisOutput(ctx);
    const styleId = input.styleId ?? output?.styleId ?? output?.request.styleId ?? null;
    // This output's row decides the carton barcode's symbology, so the barcode
    // values are resolved for it.
    const resolved = styleId ? await resolvedTokens(styleId, { variantKey: output?.variantKey ?? null }) : null;
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

// ── get_output_settings ──────────────────────────────────────────────────────

// Where each setting that shapes an output is changed, and what the change
// reaches — written for the suggestion the agent hands the admin (paths rather
// than links: the agent quotes them). Exported for tests and the bench.
export function outputSettingPlaces(input: {
  prodSpec: { id: string; name: string; stylesOnSpec: number } | null;
  layout: { id: string; name: string; prodSpecs: number; docTypeLabel: string } | null;
  style: { id: string; label: string } | null;
}): { part: string; changeIt: string }[] {
  const places: { part: string; changeIt: string }[] = [];
  places.push({
    part: "prod spec output row",
    changeIt: input.prodSpec
      ? `The prod spec's Outputs tab (/prod-specs/${input.prodSpec.id}?tab=outputs), on this output's row: whether it prints, its print ` +
        "size, admin pins (a field's value fixed for every style), Carton barcode (EAN-128 or EAN-13) and its bar height, an info area's " +
        `size. Reaches every style of prod spec "${input.prodSpec.name}" (${plural(input.prodSpec.stylesOnSpec, "style")}) for THIS output ` +
        "only; other prod specs printing the same layout keep their own row."
      : "No prod spec is known for this output's style, so there is no output row to read: pass a styleId, or ask the reviewer which style " +
        "it is about.",
  });
  if (input.layout) {
    places.push({
      part: "layout settings",
      changeIt:
        `Output Builder › the layout's Settings card (/output-builder/${input.layout.id}): repeat per size or EAN, file split, file name, ` +
        "carton numbering, multi-style, custom logo width, generation rules. Reaches every prod spec that prints the layout " +
        `(${plural(input.layout.prodSpecs, "prod spec")}) — a layout change does the same, through propose_patch.`,
    });
    places.push({
      part: "document type rules",
      changeIt:
        `Output Builder › Document types: keyword rules that skip every "${input.layout.docTypeLabel}" output for the styles they match, ` +
        "whatever the layout.",
    });
  }
  places.push({
    part: "this style's values",
    changeIt: input.style
      ? `The style's Review tab (/styles/${input.style.id}): field values and line rewrites on this output for "${input.style.label}" ` +
        "alone, and the Ignore button that stops this output for that style. Reaches this one style only."
      : "No style is known for this output, so its per-style values cannot be read.",
  });
  return places;
}

export const SETTINGS_NOTE =
  "None of this is a layout change: propose_patch drafts blocks and lines, nothing here. When the fix is one of these settings, do not " +
  "draft — finish with the setting, its new value, where it is changed (whereToChange) and what that reaches. Draft a layout change only " +
  "when the setting would reach outputs that must not change.";

export const CARTON_BARCODE_APPLIES_TO =
  "{{barcode:cartonEan}} and {{barcode:assortEan}} on carton markings (coded templates and layouts alike); " +
  "{{barcode:cartonEan13}}, {{barcode:assortEan13}} and {{barcode:ean13}} always draw EAN-13.";
export const CARTON_BARCODE_DEFAULT_SETTING = "EAN-128 / Code 128 with the number beneath — the default; the row sets nothing";
export const LINE_KEY_FORMAT = "<pageId>|<blockId>|<lineIndex>, as get_layout shows the page and block ids (line index 0-based).";

const getOutputSettings = defineTool({
  name: "get_output_settings",
  description:
    "Read the settings that shape this output besides its layout — none of which a draft can change: the prod spec's output row for the " +
    "style (whether it prints, print size, admin field pins, the carton barcode's symbology — EAN-128 or EAN-13 — and bar height, an info " +
    "area's size pick), the layout's Settings card in full (repeat per size/EAN, file split, file name, carton numbering, multi-style, " +
    "custom logo width, generation rules) and its flags, the document type's keyword rules, and this style's own review-tab overrides " +
    "(field values, line rewrites, ignore). Each with where it is changed and what that reaches. Read it before you draft and before you " +
    "conclude a value or a symbology is missing: a carton EAN prints as EAN-13 by one setting on the output row. When the fix is a setting, " +
    "do not draft — finish with the setting, its new value, where it is changed and what it reaches. styleId defaults to this output's style.",
  input: z.object({ styleId: z.string().min(1).optional() }),
  run: async (input, ctx) => {
    const output = await thisOutput(ctx);
    if (!output) return fail("get_output_settings needs the output this run works on; this run has none.");
    if (output.variantKey === COVER_VARIANT_KEY) {
      return fail(
        "This output is the cover, which has no output row or layout settings: get_cover reads it, and its whereToChange lists where " +
          "each part is changed.",
      );
    }
    const layoutId = outputLayoutId(output);
    const baseKey = output.variantKey ? baseVariantKey(output.variantKey) : layoutId ? layoutVariantKey(layoutId) : null;
    const styleId = input.styleId ?? output.styleId ?? output.request.styleId ?? null;

    const [style, layoutRow, docTypeRules, docTypeLabels, layoutUsage] = await Promise.all([
      styleId
        ? db.style.findUnique({ where: { id: styleId }, select: { id: true, name: true, poNumber: true, prodSpecId: true } })
        : Promise.resolve(null),
      layoutId
        ? db.outputLayout.findUnique({
            where: { id: layoutId },
            select: {
              id: true,
              name: true,
              docType: true,
              status: true,
              version: true,
              definition: true,
              isInfoArea: true,
              autoApprove: true,
              customLogo: true,
            },
          })
        : Promise.resolve(null),
      loadDocTypeExclusionRules().catch((): DocTypeRulesMap => ({})),
      loadDocTypeLabels().catch((): Record<string, string> => ({})),
      layoutId ? prodSpecsUsingLayout(layoutId).catch(() => []) : Promise.resolve([]),
    ]);
    if (styleId && !style) return fail(`Style ${styleId} not found.`);

    // The style's prod spec and, on it, this output's row.
    const spec = style?.prodSpecId
      ? await db.prodSpec.findUnique({ where: { id: style.prodSpecId }, select: { id: true, name: true, outputs: true } })
      : null;
    let rows: ProdSpecOutput[] = [];
    try {
      rows = spec ? parseProdSpecOutputs(spec.outputs) : [];
    } catch {
      rows = [];
    }
    const row = baseKey ? (rows.find((o) => baseVariantKey(o.variantKey) === baseKey) ?? null) : null;

    const [stylesOnSpec, sizeMap, fieldValues, lineValues, ignoredKeys] = await Promise.all([
      spec ? db.style.count({ where: { prodSpecId: spec.id, deletedAt: null, archivedAt: null } }) : Promise.resolve(0),
      row?.infoAreaSizeId ? loadInfoAreaSizeMap() : Promise.resolve(new Map()),
      style ? loadStyleFieldValues(style.id) : Promise.resolve(new Map()),
      style ? loadStyleLineValues(style.id) : Promise.resolve(new Map()),
      style ? loadIgnoredOutputKeys(style.id) : Promise.resolve(new Set<string>()),
    ]);

    // The layout's Settings card, in full, with every rule in words.
    let layout: Json | null = null;
    if (layoutRow) {
      let settings: Json | { error: string };
      try {
        const s = layoutSettings(parseLayoutDef(layoutRow.definition));
        settings = { ...s, rules: s.rules.map((r) => ({ ...r, sentence: ruleSentence(r) })) };
      } catch (err) {
        settings = { error: `The live definition does not parse: ${errorText(err)}` };
      }
      layout = {
        id: layoutRow.id,
        name: layoutRow.name,
        docType: layoutRow.docType,
        docTypeLabel: docTypeLabel(layoutRow.docType, docTypeLabels),
        status: layoutRow.status,
        version: layoutRow.version,
        isInfoArea: layoutRow.isInfoArea,
        autoApprove: layoutRow.autoApprove,
        hasCustomLogo: layoutRow.customLogo !== null,
        printedBy: { prodSpecs: layoutUsage.length, prodSpecNames: layoutUsage.map((u) => u.prodSpecName).slice(0, 8) },
        settings,
      };
    }

    const ignoreKey = baseKey ? ignoreBaseKey(baseKey, layoutRow?.docType ?? "") : null;
    const perDocPrefix = baseKey ? `${baseKey}#` : null;
    const perDocument = <V>(all: ReadonlyMap<string, V>): Record<string, V> =>
      Object.fromEntries([...all].filter(([k]) => perDocPrefix && k.startsWith(perDocPrefix)).map(([k, v]) => [k.slice(perDocPrefix!.length), v]));
    const lines = baseKey ? splitLineValues(lineValues, baseKey) : { base: undefined, perDoc: new Map<string, Record<string, string>>() };

    const kind = !output.variantKey || isLayoutVariantKey(output.variantKey) ? "layout" : "coded template";
    await note(
      ctx,
      "read",
      `Settings of "${output.label}"${style ? ` · ${style.name}` : ""}${spec ? ` · ${spec.name}` : ""}${row ? "" : " (no output row)"}`,
    );
    return ok({
      output: { label: output.label, variantKey: output.variantKey, layoutId, printsFrom: kind },
      style: style ? { id: style.id, label: style.name, poNumber: style.poNumber } : null,
      prodSpec: spec ? { id: spec.id, name: spec.name, stylesOnSpec } : null,
      outputRow: row
        ? {
            enabled: row.enabled !== false,
            widthMm: row.widthMm,
            heightMm: row.heightMm,
            printsAtMm: effectiveOutputDims(row, layoutRow?.isInfoArea ?? false, sizeMap),
            // Admin pins: a field's value fixed for every style of the spec on this output.
            pins: parseFieldOverrides(row.fieldOverrides),
            cartonBarcode: {
              type: row.cartonBarcodeType ?? "ean128",
              setting:
                row.cartonBarcodeType === "ean13"
                  ? "EAN-13 (digits inside the symbol)"
                  : CARTON_BARCODE_DEFAULT_SETTING,
              heightMm: row.cartonBarcodeHeightMm ?? null,
              appliesTo: CARTON_BARCODE_APPLIES_TO,
            },
            infoAreaSize: row.infoAreaSizeId
              ? (() => {
                  const size = sizeMap.get(row.infoAreaSizeId!);
                  return size
                    ? { id: size.id, name: size.name, widthMm: size.widthMm, heightMm: size.heightMm, active: size.active }
                    : { id: row.infoAreaSizeId, missing: true, note: "The size was deleted; the row's own widthMm × heightMm print." };
                })()
              : null,
          }
        : null,
      ...(row
        ? {}
        : {
            outputRowNote: !style
              ? "No style to read a prod spec from: pass a styleId."
              : !spec
                ? `Style ${style.name} has no prod spec, so no output row.`
                : baseKey
                  ? `Prod spec "${spec.name}" has no row for ${baseKey}: this style does not print this output.`
                  : "This output has no variant key or layout yet, so its row cannot be found.",
          }),
      otherOutputsOnSpec: rows
        .filter((o) => baseVariantKey(o.variantKey) !== baseKey)
        .map((o) => ({
          variantKey: o.variantKey,
          enabled: o.enabled !== false,
          widthMm: o.widthMm,
          heightMm: o.heightMm,
          ...(o.cartonBarcodeType ? { cartonBarcodeType: o.cartonBarcodeType } : {}),
        })),
      layout,
      docTypeRules: layoutRow ? (docTypeRules[layoutRow.docType] ?? []).map((r) => ({ ...r, sentence: ruleSentence(r) })) : [],
      thisStyle: style
        ? {
            fieldValues: (ignoreKey ? fieldValues.get(ignoreKey) : undefined) ?? {},
            fieldValuesPerDocument: perDocument(fieldValues),
            lineValues: lines.base ?? {},
            lineValuesPerDocument: Object.fromEntries(lines.perDoc),
            ignored: ignoreKey ? ignoredKeys.has(ignoreKey) : false,
            lineKeyFormat: LINE_KEY_FORMAT,
          }
        : null,
      whereToChange: outputSettingPlaces({
        prodSpec: spec ? { id: spec.id, name: spec.name, stylesOnSpec } : null,
        layout: layoutRow
          ? {
              id: layoutRow.id,
              name: layoutRow.name,
              prodSpecs: layoutUsage.length,
              docTypeLabel: docTypeLabel(layoutRow.docType, docTypeLabels),
            }
          : null,
        style: style ? { id: style.id, label: style.name } : null,
      }),
      note: SETTINGS_NOTE,
    });
  },
});

// ── get_cover ────────────────────────────────────────────────────────────────

const COVER_MARKDOWN_MAX = 6000;

// Where each part of the cover is changed, written for the suggestion the
// agent hands the admin. Paths rather than links: the agent quotes them.
export function coverEditPlaces(input: {
  prodSpecId: string;
  prodSpecName: string;
  stylesOnSpec: number;
  trimsOnCover: boolean;
}): { part: string; changeIt: string }[] {
  const spec = `/prod-specs/${input.prodSpecId}`;
  return [
    {
      part: "header",
      changeIt:
        "The style's own data from Monday: style name and number, PO, customer, business area, supplier. Fix it at the source; " +
        "nothing on the cover overrides it.",
    },
    {
      part: "required packaging",
      changeIt:
        `Which rows print: the prod spec's enabled outputs (${spec}?tab=outputs), less doc-type exclusion rules (Output Builder › ` +
        "Doc types) and outputs ignored on the style. A row's size is its output's; confirmed vs waiting follows the review of the " +
        "style's documents. The words a row prints: Settings › Cover page › Packaging rows (/settings/cover-page?tab=packaging). " +
        (input.trimsOnCover
          ? "Trims on cover is ON, so the style's Trims column on Monday adds rows too."
          : "Trims on cover is OFF, so Monday's Trims column adds no rows."),
    },
    {
      part: "cover block",
      changeIt:
        "Settings › Cover page (/settings/cover-page). ONE text printed on every cover of every customer: changing it changes all of them.",
    },
    {
      part: "general information",
      changeIt:
        `Settings › Cover page › General information (/settings/cover-page?tab=general-info), or the prod spec's General ` +
        `information tab (${spec}?tab=general). Per customer and business area: it prints on the ` +
        `${plural(input.stylesOnSpec, "style")} of prod spec "${input.prodSpecName}".`,
    },
    {
      part: "page settings",
      changeIt: `Margins and print settings of the cover sheet: the prod spec's Cover page tab (${spec}?tab=cover).`,
    },
  ];
}

const getCover = defineTool({
  name: "get_cover",
  description:
    "Read a style's cover document (\"Prod Spec\", the first PDF of its bundle): what it prints right now, part by part, and where each part " +
    "is changed. The cover is printed by code, not an Output Builder layout, so no draft can change it — use this on a request about the " +
    "cover, then suggest the change to the admin with finish. Parts: the header (the style's identity), the required-packaging rows (each " +
    "with size and whether it is confirmed), the cover block (the same text on every cover) and the prod spec's general information. " +
    "styleId defaults to this output's style.",
  input: z.object({ styleId: z.string().min(1).optional() }),
  run: async (input, ctx) => {
    let styleId = input.styleId ?? null;
    if (!styleId) {
      const output = await thisOutput(ctx);
      styleId = output?.styleId ?? output?.request.styleId ?? null;
    }
    if (!styleId) {
      return fail("This request names no style, so there is no cover to read. Pass a styleId, or ask the reviewer which style it is about.");
    }

    const [{ loadStyleCoverInput }, { getTrimsOnCoverEnabled }] = await Promise.all([
      import("@/lib/pdf/style-cover"),
      import("@/lib/settings/app-settings"),
    ]);
    const cover = await loadStyleCoverInput(styleId);
    if (!cover) return fail(`Style ${styleId} not found.`);
    if (!cover.prodSpecId) {
      return fail(`Style ${styleId} has no prod spec, so it has no bundle and no cover.`, { styleId });
    }
    const [spec, stylesOnSpec, trimsOnCover] = await Promise.all([
      db.prodSpec.findUnique({ where: { id: cover.prodSpecId }, select: { name: true } }),
      db.style.count({ where: { prodSpecId: cover.prodSpecId, deletedAt: null, archivedAt: null } }),
      getTrimsOnCoverEnabled().catch(() => false),
    ]);

    const c = cover.input;
    const markdown = (md: string | undefined) => (md?.trim() ? clip(md.trim(), COVER_MARKDOWN_MAX) : null);
    const packaging = c.docs.map((d) => ({
      packaging: d.displayName,
      size: d.widthMm != null && d.heightMm != null ? `${round(d.widthMm, 1)}×${round(d.heightMm, 1)} mm` : null,
      files: d.fileCount,
      status: d.approved === undefined ? null : d.approved ? (d.copy?.delivered ?? "confirmed") : (d.copy?.pending ?? "waiting"),
      from: d.kind ?? "app",
      ...(d.sourceLabel && d.sourceLabel !== d.displayName ? { mondayTrim: d.sourceLabel } : {}),
      ...(d.copy?.note ? { note: d.copy.note } : {}),
    }));

    await note(ctx, "read", `Cover of ${c.styleName}: ${plural(packaging.length, "packaging row")}`);
    return ok({
      styleId,
      prints: {
        header: {
          customer: c.customerName,
          businessArea: c.businessArea,
          style: c.styleName,
          styleNumber: c.styleNumber,
          poNumber: c.poNumber,
          supplier: c.supplierName,
        },
        requiredPackaging: packaging,
        coverBlock: markdown(c.coverInfo?.markdown),
        generalInformation: markdown(c.generalInfo?.markdown),
      },
      whereToChange: coverEditPlaces({
        prodSpecId: cover.prodSpecId,
        prodSpecName: spec?.name ?? cover.prodSpecId,
        stylesOnSpec,
        trimsOnCover,
      }),
    });
  },
});

// ── propose_patch ────────────────────────────────────────────────────────────

const OPS_MAX = 50;

// Why an output with no layout may NOT be pinned to `layoutId`, or null when
// it may: the output's style (else the request's) must print that layout — an
// enabled output on its ProdSpec whose base key is layout:<id>.
async function pinRefusal(
  output: { label: string; styleId: string | null; request: { styleId: string | null } },
  layoutId: string,
): Promise<ToolResult | null> {
  const styleId = output.styleId ?? output.request.styleId;
  if (!styleId) {
    return fail(
      `This output ("${output.label}") has no layout yet and the request names no style, so there is no way to tell which layout ` +
        "it prints from. Ask the reviewer (ask_reviewer) which output or style this is about.",
    );
  }
  const style = await db.style.findUnique({ where: { id: styleId }, select: { prodSpecId: true } });
  const spec = style?.prodSpecId
    ? await db.prodSpec.findUnique({ where: { id: style.prodSpecId }, select: { id: true, outputs: true } })
    : null;
  if (!spec || layoutOutputsInSpecs([spec], layoutId).length === 0) {
    return fail(
      `This output ("${output.label}") has no layout yet, and the request's style (${styleId}) does not print layout ${layoutId}. ` +
        "Only a layout that style prints can be drafted: find_layouts lists them. If the issue is about another layout, ask the reviewer.",
      { styleId, layoutId },
    );
  }
  return null;
}

const proposePatch = defineTool({
  name: "propose_patch",
  description:
    "Draft a change to THIS output's layout as a list of edit operations. Nothing prints differently: the result is a new DRAFT revision for a " +
    "person to review. The ops apply on top of this output's current draft when it has one (so you can refine it), else on the live layout " +
    "(also when the live layout changed after that draft; the result says so). " +
    "Ops: add_block, remove_block, set_rect (move/resize, grid cells), set_block_props (fontPt, bold, align, valign, fitWidth, fitHeight, " +
    "lineHeight, invert, border), edit_line / remove_line (quote the current text as oldText), insert_line. page and line are 0-based; blocks are " +
    "addressed by id (get_layout). Each op is checked on its own: rejected ops come back with a reason and the rest still apply; warnings flag " +
    "likely overlap or overflow. Returns the revisionId and a plain list of what changed against the live layout. Then render_proof it on the " +
    "request's style and on one style it must not affect. Only this output's layout can be drafted; an output with no layout yet can only be " +
    "drafted on a layout the request's style prints.",
  input: z.object({
    layoutId: z.string().min(1),
    ops: z.array(LayoutOpSchema).min(1).max(OPS_MAX),
    note: z.string().trim().min(1).max(500).describe("One line for the reviewer: what this draft changes and why."),
  }),
  run: async (input, ctx) => {
    if (!ctx.outputId) return fail("propose_patch needs the output this run works on; this run has none.");
    const output = await getOutputWithRequest(ctx.outputId);
    if (!output) return fail(`Output ${ctx.outputId} not found.`);
    if (output.status !== "WORKING") return notWorking("propose_patch", output.status);

    const ownLayoutId = outputLayoutId(output);
    if (ownLayoutId && ownLayoutId !== input.layoutId) {
      return fail(
        `This output ("${output.label}") prints from layout ${ownLayoutId}; only that layout can be drafted in this run. ` +
          "If the change belongs on another output, say so with ask_reviewer.",
        { layoutId: ownLayoutId },
      );
    }
    if (output.variantKey === COVER_VARIANT_KEY) {
      return fail(
        "This output is the cover, which is printed by code, not an Output Builder layout: no draft can change it. Read it with " +
          "get_cover and end with finish, suggesting the change for the admin to make by hand.",
      );
    }
    if (!ownLayoutId && output.variantKey && !isLayoutVariantKey(output.variantKey)) {
      return fail(
        `This output ("${output.label}") prints from a coded template (${output.variantKey}), not an Output Builder layout, so a layout draft ` +
          "cannot change it. Use ask_reviewer (or declare_gap when it needs new code).",
      );
    }

    // An output with no layout yet gets pinned to the drafted one. Only to a
    // layout the request's style really prints: otherwise a run could attach
    // the request to (and later publish a change of) any layout at all.
    if (!ownLayoutId) {
      const refusal = await pinRefusal(output, input.layoutId);
      if (refusal) return refusal;
    }

    const layout = await db.outputLayout.findUnique({
      where: { id: input.layoutId },
      select: { id: true, name: true, definition: true, version: true },
    });
    if (!layout) return fail(`Layout ${input.layoutId} not found.`);

    let live: LayoutDef;
    try {
      live = parseLayoutDef(layout.definition);
    } catch (err) {
      return fail(`The live definition of "${layout.name}" does not parse: ${errorText(err)}`);
    }
    // Refine this output's open draft — unless the live layout moved on since
    // it was made; then the ops go onto the live layout (still linked to the
    // draft as its revision) so nothing done in the builder is undone.
    const parent = await openDraftOn(output, layout.id);
    const stale = parent ? draftIsStale(parent, layout) : false;
    const baseKind = parent && !stale ? "draft" : "live";
    const base = parent && !stale ? parseLayoutDef(parent.definition) : live;
    const staleNotice = stale
      ? {
          staleDraft: { revisionId: parent?.id, number: parent?.number },
          notice:
            `The live layout changed after draft #${parent?.number} was made, so these ops were applied to the live layout. ` +
            "Include any of that draft's changes you still want.",
        }
      : {};

    const result = applyLayoutOps(base, input.ops);
    if (result.applied.length === 0) {
      await note(ctx, "draft", `No draft: all ${plural(result.rejected.length, "op")} rejected`);
      return fail("No op could be applied, so no draft was made. Fix the ops below and try again.", {
        base: baseKind,
        ...staleNotice,
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
    // this run builds on it and impact_list caches against it; a stored impact
    // belonged to the previous revision, so it goes in the same write. An
    // output that had no layout yet is pinned to this one. The job counts
    // drafts per run (draftCount) when it hands the result to review.
    await db.changeRequestOutput.update({
      where: { id: output.id },
      data: {
        currentRevisionId: revision.id,
        impact: Prisma.DbNull,
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
      base: baseKind,
      ...staleNotice,
      parentRevisionId: parent?.id ?? null,
      // The applied ops as stored — an added block carries the id it was
      // given, so a follow-up op can address it.
      applied: result.applied,
      rejected: result.rejected,
      warnings: result.warnings,
      changes,
      next: "render_proof this revision on the request's style and on one style it must not affect, then impact_list.",
    });
  },
});

// ── render_proof ─────────────────────────────────────────────────────────────

// Proof pictures go back to the model as images: their long edge is capped so
// a big carton marking doesn't come back as a multi-megapixel PNG. The scale
// is the device-pixel ratio renderHtmlPng renders at (96 dpi CSS pixels).
const PROOF_LONG_EDGE_PX = 1600;
const PROOF_MAX_SCALE = 3;
const CSS_PX_PER_MM = 96 / 25.4;

export function proofScale(longEdgeMm: number): number {
  if (!(longEdgeMm > 0)) return PROOF_MAX_SCALE;
  return Math.min(PROOF_MAX_SCALE, PROOF_LONG_EDGE_PX / (longEdgeMm * CSS_PX_PER_MM));
}

// The longest page edge any of the definitions declares (0 when none does).
function longestPageMm(...defs: unknown[]): number {
  let max = 0;
  for (const def of defs) {
    const pages = (def as { pages?: unknown } | null)?.pages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages as { widthMm?: unknown; heightMm?: unknown }[]) {
      for (const mm of [Number(page?.widthMm), Number(page?.heightMm)]) if (mm > max) max = mm;
    }
  }
  return max;
}

const renderProofTool = defineTool({
  name: "render_proof",
  description:
    "Render a revision as PNG images for one style: \"before\" is the layout as it prints today, \"after\" the draft, both through the same " +
    "faithful per-output render the runner uses (pins, carton preference, size). Returns both sides by default, with captions and the page " +
    "size in mm. Look at them: check the change landed where the screenshot asked, nothing overflows or overlaps, text is at least 5 pt, and " +
    "that a style which must not change looks the same on both sides. For an output split into several files, pick one with suffix " +
    "(e.g. a size) — otherwise the first document is shown. Only this output's own drafts can be rendered, at most 16 times per run.",
  input: z.object({
    revisionId: z.string().min(1),
    styleId: z.string().min(1),
    side: z.enum(["before", "after", "both"]).optional(),
    suffix: z.string().min(1).max(200).optional().describe("Document of a split output (the part after # in its key)."),
  }),
  run: async (input, ctx) => {
    const owned = await ownRevision(ctx, input.revisionId, "render_proof");
    if (owned.error) return owned.error;
    const spent = budgetSpent(ctx, "render_proof");
    if (spent) return spent;
    spendBudget(ctx, "render_proof");

    const { renderProof } = await import("../proofs");
    const sides: readonly ProofSide[] = !input.side || input.side === "both" ? ["before", "after"] : [input.side];
    const style = await db.style.findUnique({ where: { id: input.styleId }, select: { name: true } });
    const label = style?.name ?? input.styleId;
    const images: NonNullable<ToolResult["images"]> = [];
    const rendered: Json[] = [];
    // The scale from the page size the definitions declare; the output's own
    // size can differ (ProdSpec dimensions), so a picture that came out too
    // big is rendered once more at the scale its real size calls for.
    let scale = proofScale(longestPageMm(owned.revision.definition, owned.revision.baseDefinition));
    for (const side of sides) {
      try {
        const render = (s: number) =>
          renderProof({
            revisionId: input.revisionId,
            styleId: input.styleId,
            side,
            scale: s,
            ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
          });
        let proof = await render(scale);
        const fit = proofScale(Math.max(proof.widthMm, proof.heightMm));
        if (fit < scale - 1e-9) {
          scale = fit;
          proof = await render(scale);
        }
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
    "touches far more documents than the request implies is a sign the draft is too broad. Only this output's own drafts, at most 4 " +
    "times per run.",
  input: z.object({ revisionId: z.string().min(1) }),
  run: async (input, ctx) => {
    const owned = await ownRevision(ctx, input.revisionId, "impact_list");
    if (owned.error) return owned.error;
    const spent = budgetSpent(ctx, "impact_list");
    if (spent) return spent;
    spendBudget(ctx, "impact_list");

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
    const output = await getOutputWithRequest(ctx.outputId);
    if (!output) return fail(`Output ${ctx.outputId} not found.`);
    if (output.status !== "WORKING") return notWorking("ask_reviewer", output.status);
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
    // The requester is told by email; sendRequesterUpdate is fail-soft.
    if (input.to === "requester") {
      const { sendRequesterUpdate } = await import("../emails");
      await sendRequesterUpdate(ctx.requestId, "needs_info", { outputId: ctx.outputId, message: input.question });
    }
    await note(ctx, "question", `Asked the ${input.to}: ${clip(input.question.replace(/\s+/g, " "), 200)}`, { to: input.to });
    return ok({ ok: true, messageId: message.id, to: input.to, status });
  },
});

// ── propose_memory ───────────────────────────────────────────────────────────

const proposeMemory = defineTool({
  name: "propose_memory",
  description:
    "Suggest a short note for future runs, learned from this request or from a reviewer's correction (\"this customer wants quantities in " +
    "bold\"). A person keeps or dismisses it; only kept notes are ever read. scope: CUSTOMER (scopeRef = customer id; defaults to the " +
    "request's customer), DOC_TYPE (scopeRef = doc type, e.g. STICKER; defaults to this output's layout doc type) or MONDAY (how the data " +
    "is written). sourceKind: CORRECTION (a reviewer corrected you), AGENT_FINDING or REQUEST. One fact per note, at most 3 per run.",
  input: z.object({
    // GLOBAL notes steer every future run for every customer: an admin writes
    // those on /settings/agent-memory, the agent can't propose one.
    scope: MemoryScopeSchema.exclude(["GLOBAL"]),
    scopeRef: z.string().min(1).max(120).optional(),
    text: z.string().trim().min(1).max(1000),
    sourceKind: MemorySourceKindSchema,
  }),
  run: async (input, ctx) => {
    if (!ctx.requestId || !ctx.outputId) return fail("propose_memory needs the request and output this run works on.");
    const output = await getOutputWithRequest(ctx.outputId);
    if (!output) return fail(`Output ${ctx.outputId} not found.`);
    if (output.status !== "WORKING") return notWorking("propose_memory", output.status);
    const spent = budgetSpent(ctx, "propose_memory");
    if (spent) return spent;
    // Reserved now, so parallel calls in one turn all count against it;
    // handed back when no note gets made.
    spendBudget(ctx, "propose_memory");
    return proposeMemoryNote(input, ctx, output);
  },
});

async function proposeMemoryNote(
  input: { scope: "CUSTOMER" | "DOC_TYPE" | "MONDAY"; scopeRef?: string; text: string; sourceKind: MemorySourceKind },
  ctx: ToolContext,
  output: NonNullable<Awaited<ReturnType<typeof getOutputWithRequest>>>,
): Promise<ToolResult> {
  let scopeRef = input.scopeRef ?? null;
  if (!scopeRef && (input.scope === "CUSTOMER" || input.scope === "DOC_TYPE")) {
    if (input.scope === "CUSTOMER") {
      scopeRef = output.request.customerId ?? null;
    } else {
      const layoutId = outputLayoutId(output);
      const layout = layoutId
        ? await db.outputLayout.findUnique({ where: { id: layoutId }, select: { docType: true } })
        : null;
      scopeRef = layout?.docType ?? null;
    }
    if (!scopeRef) {
      refundBudget(ctx, "propose_memory");
      return fail(`A ${input.scope} note needs scopeRef (the ${input.scope === "CUSTOMER" ? "customer id" : "doc type"}).`);
    }
  }
  let memory;
  try {
    memory = await createProposedMemory({
      scope: input.scope,
      scopeRef,
      text: input.text,
      sourceKind: input.sourceKind,
      sourceRequestId: ctx.requestId,
    });
  } catch (err) {
    refundBudget(ctx, "propose_memory");
    throw err;
  }
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
}

// ── finish ───────────────────────────────────────────────────────────────────

const finish = defineTool({
  name: "finish",
  description:
    "End the run with a plain-language message for the reviewer. After a draft: what you changed and why, which styles you checked " +
    "(including the one that must not change), how many documents the impact list says would change, and anything they should look at; " +
    "call it after propose_patch, render_proof and impact_list. If the reviewer only asked a question, or no layout change is needed or " +
    "possible, answer with finish and explain — do not make a new draft. Either way the output goes to the reviewer, and a draft you did " +
    "not change stays as it is.",
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
  getOutputSettings,
  getCover,
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
