import { z } from "zod";
import { db } from "@/lib/db";
import {
  LayoutDefSchema,
  parseLayoutDef,
  tokensInLine,
  IF_RE,
  CONTROL_RE,
  type LayoutDef,
} from "@/lib/output-layouts/schema";
import {
  LAYOUT_TOKENS,
  BARCODE_SOURCES,
  LOGO_SOURCES,
  CERT_SOURCES,
  validateTokenRef,
  validateLineConditionals,
} from "@/lib/output-layouts/token-meta";
import { layoutIdFromVariantKey, layoutVariantKey } from "@/lib/output-layouts/variant-keys";
import { refreshLayoutVariants } from "@/lib/output-layouts/variants";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import {
  resolveTextToken,
  unresolvedTokens,
  augmentTranslatedFields,
  augmentCompositionTranslations,
  compositionLangsInDef,
  langArgsInDef,
} from "@/lib/output-layouts/tokens";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { currentOutputBaseKeys } from "@/lib/tickets/orphan";
import { getSystemPromptContent, REJECTION_FIX_PROMPT_KEY } from "@/lib/prompts/system-prompts";
import { callClaudeForJson } from "./anthropic";

// =====================================================
// AI rejection-fix — proposal side.
//
// Given a rejection ticket whose output is an Output Builder layout, hand
// Claude the reviewer's comment, the layout's text lines, the variable
// catalogue and — for the rejected style — what each variable resolves to,
// and ask for the SMALLEST set of line-text edits that fixes the complaint.
//
// The model returns a flat list of line edits (page/block/line index +
// old/new text). We apply them by replacing `lines[i]` strings ONLY — so the
// "text & tokens only" scope is enforced structurally: geometry, blocks and
// fonts can never change. Each edit is validated (index in range, old text
// matches, new text uses only real tokens / well-formed conditionals) before
// it's applied; the whole result is re-validated against LayoutDefSchema.
// Nothing is persisted here — the caller previews before/after and only the
// apply route writes.
// =====================================================

export class AiFixError extends Error {
  constructor(
    public readonly httpStatus: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "AiFixError";
  }
}

export type AiFixEdit = {
  pageIndex: number;
  blockIndex: number;
  lineIndex: number;
  oldText: string;
  newText: string;
};

export type AiFixProposal = {
  layoutId: string;
  layoutName: string;
  styleId: string;
  styleLabel: string;
  // How many Prod Specs reference this layout — the blast radius of applying
  // the edit (the edit changes the template for all of them).
  usedByCount: number;
  currentDef: LayoutDef;
  proposedDef: LayoutDef;
  // The model's read on whether this is a template fix at all (false = it
  // judged the real problem to be the style's data, and made no edits).
  isTemplateProblem: boolean;
  note: string;
  // Edits actually applied to produce proposedDef.
  edits: AiFixEdit[];
  // Edits the model proposed but that we rejected (bad index, stale target,
  // or invalid token/conditional) — surfaced so the reviewer knows.
  skipped: { edit: AiFixEdit; reason: string }[];
};

const AiResponseSchema = z.object({
  isTemplateProblem: z.boolean().optional(),
  note: z.string().optional(),
  edits: z
    .array(
      z.object({
        pageIndex: z.number().int(),
        blockIndex: z.number().int(),
        lineIndex: z.number().int(),
        oldText: z.string(),
        newText: z.string(),
      }),
    )
    .optional(),
});

const TICKET_SELECT = {
  id: true,
  styleId: true,
  variantKey: true,
  comment: true,
  outputName: true,
  styleName: true,
  styleNumber: true,
} as const;

// Resolve the Output Builder layout behind a ticket, or throw an AiFixError
// with a reviewer-friendly reason. Shared by the proposal and apply routes so
// the layout is always derived server-side from the ticket (never trusted
// from the client).
export async function resolveTicketLayout(
  ticketId: string,
): Promise<{ ticket: { id: string; styleId: string; variantKey: string; comment: string; outputName: string; styleName: string; styleNumber: string }; layoutId: string }> {
  const ticket = await db.rejectionTicket.findUnique({ where: { id: ticketId }, select: TICKET_SELECT });
  if (!ticket) throw new AiFixError(404, "This rejection ticket no longer exists.");
  const layoutId = layoutIdFromVariantKey(ticket.variantKey);
  if (!layoutId) {
    throw new AiFixError(
      400,
      "This output isn't an Output Builder layout, so it can't be AI-edited. Edit its source (cover / general info / coded template) directly.",
    );
  }
  return { ticket, layoutId };
}

// The `usage` line for one token in the catalogue handed to the model.
function tokenUsage(key: string, arg: "lang" | "source" | "gap" | undefined): string {
  if (arg === "lang") return `{{${key}:<lang>}}`;
  if (arg === "gap") return `{{${key}}} (optional mm gap, e.g. {{${key}:0}})`;
  if (arg === "source") {
    const sources =
      key === "barcode" ? BARCODE_SOURCES : key === "logo" ? LOGO_SOURCES : key === "cert" ? CERT_SOURCES : [];
    return sources.map((s) => `{{${key}:${s}}}`).join(" | ");
  }
  return `{{${key}}}`;
}

// The variable catalogue, grouped, as compact plaintext for the prompt.
function buildCatalog(): string {
  const byGroup = new Map<string, string[]>();
  for (const t of LAYOUT_TOKENS) {
    const line = `  ${tokenUsage(t.key, t.arg)} — ${t.label}`;
    const list = byGroup.get(t.group) ?? [];
    list.push(line);
    byGroup.set(t.group, list);
  }
  const parts: string[] = [];
  for (const [group, lines] of byGroup) {
    parts.push(`${group}:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// Resolve every text token against the rejected style, so the model can tell
// "wrong word in the template" from "this field is empty for this style".
type StyleData = Awaited<ReturnType<typeof loadStyleRenderContext>>;
function buildResolvedValues(styleData: NonNullable<StyleData>["styleData"]): string {
  const lines: string[] = [];
  for (const t of LAYOUT_TOKENS) {
    if (t.kind !== "text") continue; // barcodes / logos / symbols aren't textual values
    const isLang = t.arg === "lang";
    const key = isLang ? `${t.key}:en` : t.key;
    const value = isLang ? resolveTextToken(styleData, t.key, "en") : resolveTextToken(styleData, t.key);
    lines.push(`  ${key} = ${value.trim() ? JSON.stringify(value) : "<empty>"}`);
  }
  return lines.join("\n");
}

// The layout's lines with [page.block.line] indices the model must reference.
function buildLineIndex(def: LayoutDef): string {
  const parts: string[] = [];
  def.pages.forEach((page, p) => {
    parts.push(`Page ${p}${page.title ? ` — ${page.title}` : ""}:`);
    if (page.blocks.length === 0) parts.push("  (no blocks)");
    page.blocks.forEach((block, b) => {
      parts.push(`  Block ${b}:`);
      if (block.lines.length === 0) parts.push("    (no lines)");
      block.lines.forEach((line, l) => {
        parts.push(`    [${p}.${b}.${l}] ${JSON.stringify(line)}`);
      });
    });
  });
  return parts.join("\n");
}

function buildUserMessage(input: {
  comment: string;
  outputName: string;
  styleLabel: string;
  def: LayoutDef;
  values: string;
  unresolved: string[];
}): string {
  const unresolvedNote =
    input.unresolved.length > 0
      ? `Variables that currently DON'T resolve for this style (likely a data gap, not a template gap):\n  ${input.unresolved.join(", ")}`
      : "Every variable currently in the layout resolves to a value for this style.";

  return [
    `A reviewer rejected the output "${input.outputName}" for style ${input.styleLabel}.`,
    ``,
    `REVIEWER'S COMMENT:\n${input.comment || "(no comment left)"}`,
    ``,
    `CURRENT LAYOUT LINES (edit the text of these — reference each by its [page.block.line] index):`,
    buildLineIndex(input.def),
    ``,
    `AVAILABLE VARIABLES (use ONLY these; copy keys and arguments exactly):`,
    buildCatalog(),
    ``,
    `Conditionals are single-line: {{if field == VALUE}}…{{else}}…{{endif}} (also != , includes, !includes).`,
    ``,
    `WHAT EACH TEXT VARIABLE RESOLVES TO FOR THIS STYLE:`,
    input.values,
    ``,
    unresolvedNote,
    ``,
    `Return ONLY a JSON object of this exact shape, with no other text:`,
    `{`,
    `  "isTemplateProblem": boolean,   // false if the real fix is in the style's DATA, not the template`,
    `  "note": string,                 // 1-2 plain sentences explaining the change (or why it's a data problem)`,
    `  "edits": [`,
    `    { "pageIndex": number, "blockIndex": number, "lineIndex": number, "oldText": string, "newText": string }`,
    `  ]`,
    `}`,
    `Each edit must reference an existing [pageIndex.blockIndex.lineIndex] above, with oldText copied EXACTLY from that line and newText the replacement. If this is a data problem, set isTemplateProblem to false and return an empty edits array.`,
  ].join("\n");
}

// Token / conditional validity of one proposed line (same gate the publish
// endpoint uses), plus the stored-line length cap.
function validateLineText(text: string): string[] {
  const errs: string[] = [];
  if (text.length > 500) errs.push("line exceeds the 500-character limit");
  for (const ref of tokensInLine(text)) errs.push(...validateTokenRef(ref.key, ref.arg));
  errs.push(...validateLineConditionals(text, IF_RE, CONTROL_RE));
  return errs;
}

// Apply the model's edits to a deep copy of the definition, replacing only
// `lines[i]` strings. Returns the applied + skipped edits and the re-validated
// proposed definition.
function applyEdits(
  def: LayoutDef,
  edits: AiFixEdit[],
): { proposedDef: LayoutDef; applied: AiFixEdit[]; skipped: { edit: AiFixEdit; reason: string }[] } {
  const clone: LayoutDef = JSON.parse(JSON.stringify(def));
  const applied: AiFixEdit[] = [];
  const skipped: { edit: AiFixEdit; reason: string }[] = [];

  for (const edit of edits) {
    const page = clone.pages[edit.pageIndex];
    const block = page?.blocks[edit.blockIndex];
    if (!page || !block) {
      skipped.push({ edit, reason: "no block at that page/block index" });
      continue;
    }
    if (edit.lineIndex < 0 || edit.lineIndex >= block.lines.length) {
      skipped.push({ edit, reason: "no line at that index" });
      continue;
    }
    const current = block.lines[edit.lineIndex];
    if (edit.oldText !== current) {
      skipped.push({ edit, reason: "the line changed since — old text doesn't match" });
      continue;
    }
    if (edit.newText === current) continue; // no-op, silently ignore
    const errs = validateLineText(edit.newText);
    if (errs.length > 0) {
      skipped.push({ edit, reason: errs.join("; ") });
      continue;
    }
    block.lines[edit.lineIndex] = edit.newText;
    applied.push(edit);
  }

  // Re-validate the whole thing so a bad edit can never yield an unparseable
  // definition downstream.
  const proposedDef = LayoutDefSchema.parse(clone);
  return { proposedDef, applied, skipped };
}

// Count Prod Specs that reference this layout (the blast radius). Best-effort:
// any read failure yields 0 rather than blocking the proposal.
async function countProdSpecsUsingLayout(layoutId: string): Promise<number> {
  const key = layoutVariantKey(layoutId);
  try {
    const specs = await db.prodSpec.findMany({ select: { outputs: true } });
    let n = 0;
    for (const s of specs) {
      try {
        if (currentOutputBaseKeys(parseProdSpecOutputs(s.outputs)).has(key)) n++;
      } catch {
        // one spec's malformed outputs shouldn't skew the whole count
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export async function buildAiFixProposal(ticketId: string): Promise<AiFixProposal> {
  const { ticket, layoutId } = await resolveTicketLayout(ticketId);

  const layout = await db.outputLayout.findUnique({
    where: { id: layoutId },
    select: { id: true, name: true, definition: true },
  });
  if (!layout) throw new AiFixError(404, "The layout behind this output no longer exists.");
  const currentDef = parseLayoutDef(layout.definition);

  const ctx = await loadStyleRenderContext(ticket.styleId);
  if (!ctx) throw new AiFixError(400, "Couldn't load the rejected style's data to reason about the fix.");

  // Resolve translation-backed tokens for the languages the layout uses (+ en)
  // so the resolved-values map matches what actually prints — mirrors the
  // preview route's augmentation.
  let styleData = ctx.styleData;
  const compLangs = [...new Set([...compositionLangsInDef(currentDef), "en"])];
  if (compLangs.length > 0) styleData = await augmentCompositionTranslations(styleData, compLangs);
  styleData = await augmentTranslatedFields(styleData, {
    care: [...new Set([...langArgsInDef(currentDef, "careInstructions"), "en"])],
    madeIn: [...new Set([...langArgsInDef(currentDef, "madeIn"), "en"])],
    madeInLabel: [...new Set([...langArgsInDef(currentDef, "madeInLabel"), "en"])],
    country: [...new Set([...langArgsInDef(currentDef, "country"), "en"])],
    countryOfOriginLabel: [...new Set([...langArgsInDef(currentDef, "countryOfOriginLabel"), "en"])],
    manufacturer: [...new Set([...langArgsInDef(currentDef, "manufacturer"), "en"])],
  });

  const styleLabel = [ticket.styleName, ticket.styleNumber].filter(Boolean).join(" · ") || ticket.styleId;
  const system = await getSystemPromptContent(REJECTION_FIX_PROMPT_KEY);
  const user = buildUserMessage({
    comment: ticket.comment,
    outputName: ticket.outputName,
    styleLabel,
    def: currentDef,
    values: buildResolvedValues(styleData),
    unresolved: unresolvedTokens(currentDef, styleData),
  });

  const raw = await callClaudeForJson({ system, user, maxTokens: 2048 });
  const parsed = AiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiFixError(400, "The AI response wasn't in the expected format — try again.");
  }

  const isTemplateProblem = parsed.data.isTemplateProblem !== false; // default true
  const note = (parsed.data.note ?? "").trim();
  const { proposedDef, applied, skipped } = applyEdits(currentDef, parsed.data.edits ?? []);
  const usedByCount = await countProdSpecsUsingLayout(layoutId);

  return {
    layoutId,
    layoutName: layout.name,
    styleId: ticket.styleId,
    styleLabel,
    usedByCount,
    currentDef,
    proposedDef,
    isTemplateProblem,
    note,
    edits: applied,
    skipped,
  };
}

// Persist an approved proposed definition to its layout (validated), then
// refresh the variant registry if the layout is published so the change
// takes effect on the next render — exactly what a manual editor save does.
export async function applyAiFixDefinition(layoutId: string, definition: unknown): Promise<void> {
  const parsed = LayoutDefSchema.parse(definition);
  const layout = await db.outputLayout.update({
    where: { id: layoutId },
    data: { definition: parsed as object },
  });
  if (layout.status === "PUBLISHED") await refreshLayoutVariants();
}
