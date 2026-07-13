import { z } from "zod";
import { db } from "@/lib/db";
import { renderGeneralInfoHtml } from "@/lib/pdf/bundle-pages";
import { inlineProdSpecImages } from "@/lib/pdf/inline-images";
import { parseBundlePageSettings } from "@/lib/prod-spec/config";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { getSystemPromptContent, GENERAL_INFO_FIX_PROMPT_KEY } from "@/lib/prompts/system-prompts";
import { callClaudeForJson } from "./anthropic";
import { AiFixError } from "./ai-fix";

// =====================================================
// AI rejection-fix — General information page.
//
// The GI page is a single markdown document on the ProdSpec (generalInfoMd),
// shared by every style on that spec, with NO variables/tokens — so the AI
// just rewrites the markdown. We hand it the reviewer comment + the current
// markdown and ask for the smallest revision (or a decline when the fix isn't
// in the text). Before/after are rendered here through the SAME bundle
// function the runner uses (images inlined), so the dialog shows print truth.
// Nothing is saved until the apply route writes generalInfoMd.
// =====================================================

export const GENERAL_INFO_VARIANT_KEY = "__general_info__";

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

export type GeneralInfoAiFixProposal = {
  kind: "general-info";
  prodSpecId: string;
  prodSpecName: string;
  styleLabel: string;
  // Styles that share this Prod Spec (and therefore this page) — the blast radius.
  usedByCount: number;
  currentMarkdown: string;
  proposedMarkdown: string;
  // Rendered A4 HTML for the dialog's before/after frames (afterHtml is "" when
  // there's no change).
  beforeHtml: string;
  afterHtml: string;
  widthMm: number;
  heightMm: number;
  isTemplateProblem: boolean;
  note: string;
  changed: boolean;
};

const AiResponseSchema = z.object({
  isTemplateProblem: z.boolean().optional(),
  note: z.string().optional(),
  markdown: z.string().optional(),
});

// A4 placeholder when a page has no markdown (empty before, or a proposal that
// produced nothing) — mirrors the general-info-preview route's empty state.
function emptyStateHtml(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    body{width:210mm;min-height:297mm;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-family:Arial,Helvetica,sans-serif;color:#a1a1aa}
    p{max-width:120mm;text-align:center;font-size:11pt;line-height:1.6}
  </style></head><body><p>${message}</p></body></html>`;
}

export async function buildGeneralInfoAiFixProposal(ticketId: string): Promise<GeneralInfoAiFixProposal> {
  const ticket = await db.rejectionTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, styleId: true, variantKey: true, comment: true, styleName: true, styleNumber: true },
  });
  if (!ticket) throw new AiFixError(404, "This rejection ticket no longer exists.");
  if (baseVariantKey(ticket.variantKey) !== GENERAL_INFO_VARIANT_KEY) {
    throw new AiFixError(400, "This ticket isn't for the General information page.");
  }

  const style = await db.style.findUnique({
    where: { id: ticket.styleId },
    select: {
      prodSpec: {
        select: {
          id: true,
          name: true,
          generalInfoMd: true,
          bundlePageSettings: true,
          customer: { select: { name: true } },
          businessArea: { select: { name: true } },
        },
      },
    },
  });
  const prodSpec = style?.prodSpec;
  if (!prodSpec) {
    throw new AiFixError(400, "This style has no applied Prod Spec, so its general information can't be edited.");
  }

  const currentMarkdown = (prodSpec.generalInfoMd ?? "").trim();
  const styleLabel = [ticket.styleName, ticket.styleNumber].filter(Boolean).join(" · ") || ticket.styleId;
  const settings = parseBundlePageSettings(prodSpec.bundlePageSettings).generalInfo;

  const system = await getSystemPromptContent(GENERAL_INFO_FIX_PROMPT_KEY);
  const user = [
    `A reviewer rejected the "General information" page for style ${styleLabel} (customer ${prodSpec.customer.name}).`,
    ``,
    `REVIEWER'S COMMENT:\n${ticket.comment || "(no comment left)"}`,
    ``,
    `CURRENT GENERAL-INFORMATION MARKDOWN (GitHub-flavored; images are ![alt](name)):`,
    `-----`,
    currentMarkdown || "(the page is currently empty)",
    `-----`,
    ``,
    `Return ONLY a JSON object of this exact shape, with no other text:`,
    `{`,
    `  "isTemplateProblem": boolean,   // false if the real fix is NOT in this text`,
    `  "note": string,                 // 1-2 plain sentences explaining the change (or why it can't be fixed here)`,
    `  "markdown": string              // the FULL revised markdown for the page`,
    `}`,
    `Preserve everything already correct — headings, tables, lists, and especially image references (![...](...)). If this isn't a text problem, set isTemplateProblem:false and return the markdown UNCHANGED.`,
  ].join("\n");

  const raw = await callClaudeForJson({ system, user, maxTokens: 8192 });
  const parsed = AiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiFixError(400, "The AI response wasn't in the expected format — try again.");
  }
  const isTemplateProblem = parsed.data.isTemplateProblem !== false; // default true
  const note = (parsed.data.note ?? "").trim();
  const proposedRaw = typeof parsed.data.markdown === "string" ? parsed.data.markdown.trim() : "";
  // A change only when the model returned non-empty markdown AND judged it a
  // template problem — an empty/absent markdown or a decline means "no change".
  const proposedMarkdown = proposedRaw && isTemplateProblem ? proposedRaw : currentMarkdown;
  const changed = proposedMarkdown !== currentMarkdown;

  const render = async (md: string): Promise<string> => {
    if (!md.trim()) return emptyStateHtml("No general information on this page.");
    let html = renderGeneralInfoHtml({
      markdown: md,
      customerName: prodSpec.customer.name,
      businessArea: prodSpec.businessArea.name,
      settings,
    });
    html = await inlineProdSpecImages(html, prodSpec.id);
    return html;
  };
  const [beforeHtml, afterHtml] = await Promise.all([
    render(currentMarkdown),
    changed ? render(proposedMarkdown) : Promise.resolve(""),
  ]);

  let usedByCount = 0;
  try {
    usedByCount = await db.style.count({ where: { prodSpec: { id: prodSpec.id } } });
  } catch {
    // best-effort blast-radius count
  }

  return {
    kind: "general-info",
    prodSpecId: prodSpec.id,
    prodSpecName: prodSpec.name,
    styleLabel,
    usedByCount,
    currentMarkdown,
    proposedMarkdown,
    beforeHtml,
    afterHtml,
    widthMm: A4_WIDTH_MM,
    heightMm: A4_HEIGHT_MM,
    isTemplateProblem,
    note,
    changed,
  };
}

// The ProdSpec behind a general-info ticket — derived server-side so the apply
// route never trusts a client-sent id. Throws AiFixError with a clear reason.
export async function resolveTicketProdSpecId(ticket: {
  styleId: string;
  variantKey: string;
}): Promise<string> {
  if (baseVariantKey(ticket.variantKey) !== GENERAL_INFO_VARIANT_KEY) {
    throw new AiFixError(400, "This ticket isn't for the General information page.");
  }
  const style = await db.style.findUnique({
    where: { id: ticket.styleId },
    select: { prodSpec: { select: { id: true } } },
  });
  if (!style?.prodSpec) {
    throw new AiFixError(400, "This style has no applied Prod Spec, so its general information can't be edited.");
  }
  return style.prodSpec.id;
}

export async function applyGeneralInfoFix(prodSpecId: string, markdown: string): Promise<void> {
  await db.prodSpec.update({ where: { id: prodSpecId }, data: { generalInfoMd: markdown } });
}
