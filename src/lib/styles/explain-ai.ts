import { z } from "zod";
import { getSystemPromptContent, STYLE_EXPLAIN_PROMPT_KEY } from "@/lib/prompts/system-prompts";
import { callClaudeForJson } from "@/lib/rejection-ai/anthropic";

// =====================================================
// Style explainer — the AI narration layer.
//
// The DIAGNOSIS is deterministic and lives in explain.ts: the readiness
// ladder, the persisted PO scrape snapshot, size coverage, lookalike rows, the
// supplier-folder diff and the log trail are all assembled there as plain
// facts. This module only NARRATES that bundle in response to a reviewer's
// free-text question. It never decides anything.
//
// That split is deliberate. These answers send people off to edit Monday data
// that ends up printed on garment labels, so a fluent-but-invented reason is
// worse than no answer at all. Two structural guards enforce it:
//
//   1. The model is handed the bundle and told to answer ONLY from it (see
//      DEFAULT_STYLE_EXPLAIN_PROMPT), and to set `insufficient` rather than
//      speculate when the bundle doesn't cover the question.
//   2. It CANNOT invent a link. Pointers are offered to it as an id + label
//      list; it returns ids, and we map those back to the hrefs WE built. A
//      hallucinated id is dropped on the floor by resolvePointers().
//
// As with the rejection auto-fix, the editable admin prompt carries the
// guidance/persona only — the strict JSON output contract below lives in code
// so a prompt edit can never break parsing.
// =====================================================

// A place the answer can send someone. Built by explain.ts (which knows the
// real URLs — the Monday item, the prod spec, /po-eans, the supplier folder);
// offered to the model as id + label only.
export type ExplainPointer = {
  id: string;
  label: string;
  href: string | null;
};

export type StyleExplainAnswer = {
  // The reviewer-facing answer. Plain prose, a few sentences.
  answer: string;
  // The single most likely cause, when the model can name one from the
  // evidence. Null when it can't — which is a legitimate outcome, not a bug.
  likelyCause: string | null;
  // True when the model judged the bundle insufficient to answer. The UI says
  // so plainly instead of dressing a non-answer up as a diagnosis.
  insufficient: boolean;
  // Resolved from the model's returned ids against the offered pointers, so
  // every href here is one we constructed. Unknown ids are discarded.
  pointers: ExplainPointer[];
};

// What we accept back from the model. Everything optional + defaulted: a
// well-formed answer with a missing field should degrade, not 400.
const AiAnswerSchema = z.object({
  answer: z.string().optional(),
  likelyCause: z.string().nullable().optional(),
  insufficient: z.boolean().optional(),
  pointerIds: z.array(z.string()).optional(),
});

export class StyleExplainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "StyleExplainError";
  }
}

// Keep the transcript bounded. The bundle is already trimmed upstream (the PO
// scrape snapshot caps its sections), but a style with a long log trail or a
// large PO could still push the prompt further than it's worth paying for on a
// Haiku-tier call. Truncating with a visible marker is better than silently
// sending a giant prompt: the model can SEE that it was cut and say so.
const MAX_BUNDLE_CHARS = 60_000;

function serializeBundle(bundle: unknown): string {
  const json = JSON.stringify(bundle, null, 2) ?? "{}";
  if (json.length <= MAX_BUNDLE_CHARS) return json;
  return `${json.slice(0, MAX_BUNDLE_CHARS)}\n\n…[evidence truncated — it was too large to send in full]`;
}

// The strict output contract. Lives here (not in the editable prompt) and is
// appended at the END of the user message, where response-shaping instructions
// land best — same placement the rejection auto-fix uses.
function buildUserMessage(input: {
  question: string;
  bundle: unknown;
  pointers: ExplainPointer[];
}): string {
  const pointerList = input.pointers.length
    ? input.pointers.map((p) => `  ${p.id} — ${p.label}`).join("\n")
    : "  (none available for this style)";

  return [
    "The reviewer's question:",
    input.question.trim(),
    "",
    "The evidence bundle for this style (this is everything you know — do not go beyond it):",
    "```json",
    serializeBundle(input.bundle),
    "```",
    "",
    "Pointers you may attach to your answer, as id — description:",
    pointerList,
    "",
    "Return ONLY a JSON object of exactly this shape:",
    "{",
    '  "answer": string,            // a few short sentences the reviewer can act on',
    '  "likelyCause": string|null,  // the single most likely cause, or null if you cannot name one from the evidence',
    '  "insufficient": boolean,     // true if the bundle does not contain what is needed to answer',
    '  "pointerIds": string[]       // ids from the list above — at most 3, most useful first, [] if none apply',
    "}",
    "",
    "Use only ids from the list above; never invent an id, a URL, or a fact that is not in the bundle.",
  ].join("\n");
}

// Map the model's ids back onto the pointers WE built. Unknown ids are
// silently dropped (a hallucinated pointer must never reach the UI as a link),
// duplicates collapse, and the list is capped.
function resolvePointers(ids: string[] | undefined, offered: ExplainPointer[]): ExplainPointer[] {
  if (!ids?.length) return [];
  const byId = new Map(offered.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: ExplainPointer[] = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
    if (out.length === 3) break;
  }
  return out;
}

// Ask Claude the reviewer's question about one style, against a pre-built
// evidence bundle. Throws StyleExplainError for the cases a route should turn
// into a clean message; AiNotConfiguredError / AiResponseError from the shared
// client propagate as-is (the route already knows how to phrase those).
export async function answerStyleQuestion(input: {
  question: string;
  bundle: unknown;
  pointers?: ExplainPointer[];
}): Promise<StyleExplainAnswer> {
  const question = input.question.trim();
  if (!question) throw new StyleExplainError(400, "Ask a question first.");
  // Bounded so a pasted wall of text can't become the prompt.
  if (question.length > 2000) {
    throw new StyleExplainError(400, "That question is too long — try a shorter one.");
  }

  const offered = input.pointers ?? [];
  const system = await getSystemPromptContent(STYLE_EXPLAIN_PROMPT_KEY);
  const user = buildUserMessage({ question, bundle: input.bundle, pointers: offered });

  // The answer is a few sentences plus a short id list — 1024 is ample, and
  // capping it keeps a runaway generation cheap.
  const raw = await callClaudeForJson({ system, user, maxTokens: 1024 });
  const parsed = AiAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StyleExplainError(502, "The AI response wasn't in the expected format — try again.");
  }

  const answer = (parsed.data.answer ?? "").trim();
  const likelyCause = (parsed.data.likelyCause ?? "")?.trim() || null;
  // An empty answer is itself a non-answer — report it as insufficient rather
  // than rendering a blank card.
  const insufficient = parsed.data.insufficient === true || answer.length === 0;

  return {
    answer: answer || "I couldn't find anything in this style's data that answers that.",
    likelyCause,
    insufficient,
    pointers: resolvePointers(parsed.data.pointerIds, offered),
  };
}
