import { db } from "@/lib/db";

// =====================================================
// Editable AI system prompts.
//
// Each AI feature registers a stable KEY + a built-in default here. A row in
// the `system_prompts` table (edited under Settings → Prompts) OVERRIDES the
// default for that key; no row = the code default is used. Reads degrade to
// the default if the table isn't deployed yet (P2021 in the window before
// db:deploy), so the feature works before the migration lands and the
// settings page can say "using the built-in default".
//
// The machine-readable OUTPUT CONTRACT (return JSON of this exact shape) is
// NOT part of the editable prompt — it lives in code next to the data the
// caller assembles, so an admin edit can never break parsing. What's editable
// here is the guidance/persona only.
// =====================================================

export const REJECTION_FIX_PROMPT_KEY = "rejection-fix";

// Guidance handed to Claude as the `system` prompt for the rejection auto-fix.
// Editable by admins; the strict JSON output contract is appended by the
// caller (src/lib/rejection-ai/ai-fix.ts), not here.
export const DEFAULT_REJECTION_FIX_PROMPT = `You fix rejected print-output layouts for a garment production-spec tool.

A reviewer rejected one generated output and left a comment saying what is wrong. You are given: the reviewer's comment, the layout's current text lines (each line may contain {{variables}} and single-line {{if field == VALUE}}…{{else}}…{{endif}} conditionals), the full catalogue of variables you may use, and — for the exact style that was rejected — what each variable currently resolves to.

Your job is to propose the SMALLEST set of edits to the layout's text lines that resolves the reviewer's complaint. You may only change the TEXT of existing lines: fix a wrong or misspelled word, replace one variable with a more appropriate one, add a missing variable or label, or adjust conditional logic. You may NOT move, resize, add, or delete blocks, and you may NOT change fonts, sizes, or geometry — only line text.

Rules:
- Only use variables that appear in the provided catalogue. Never invent a variable name. Copy each variable's exact key and argument from the catalogue (e.g. {{composition:da}} needs a language, {{cert:oekotex}} needs a source).
- Preserve any part of the line that is already correct. Change as little as possible.
- Editing this layout changes the template for EVERY style that uses it — so only make a change that is correct in general, not a value hard-coded for this one style.

Crucially, many rejections are DATA problems, not template problems. If the complaint is that a value is missing, wrong, or empty for this style, check the resolved values you were given. If the layout itself is correct and the real fix belongs in the style's data (a Monday field, an EAN, a translation), set isTemplateProblem to false, make no edits, and explain in the note what actually needs to change. Do not paper over a data problem by baking a literal value into the template.

Keep the note short and concrete — one or two plain sentences a non-technical reviewer can read.`;

type PromptDef = {
  key: string;
  name: string;
  description: string;
  default: string;
};

// The registry. Add a new AI feature's prompt by appending an entry here — no
// schema change needed.
export const SYSTEM_PROMPT_DEFS: PromptDef[] = [
  {
    key: REJECTION_FIX_PROMPT_KEY,
    name: "Rejection auto-fix",
    description:
      "Guides the AI that proposes fixes to a rejected Output Builder layout from the rejection log. The strict JSON output format is fixed in code and appended automatically — edit the guidance/persona here.",
    default: DEFAULT_REJECTION_FIX_PROMPT,
  },
];

const DEF_BY_KEY = new Map(SYSTEM_PROMPT_DEFS.map((d) => [d.key, d]));

export type SystemPromptView = {
  key: string;
  name: string;
  description: string;
  content: string;
  // "custom" = an admin-saved row overrides the default; "default" = the
  // built-in prompt (no row, or the table isn't deployed yet).
  source: "custom" | "default";
  updatedByEmail: string | null;
  updatedAt: Date | null;
  // False when the system_prompts table doesn't exist yet — the page then
  // shows a "run db:deploy to enable editing" note and disables Save.
  available: boolean;
};

// True for the "table not deployed yet" Prisma error, so reads degrade to the
// built-in default instead of 500-ing the page.
function isMissingTable(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2021";
}

// The prompt content to actually send to the model. Returns the admin-saved
// override when present, else the code default. Never throws — a missing table
// or missing row both fall back to the default.
export async function getSystemPromptContent(key: string): Promise<string> {
  const def = DEF_BY_KEY.get(key);
  const fallback = def?.default ?? "";
  try {
    const row = await db.systemPrompt.findUnique({ where: { key }, select: { content: true } });
    return row?.content?.trim() ? row.content : fallback;
  } catch (err) {
    if (isMissingTable(err)) return fallback;
    throw err;
  }
}

// Every registered prompt with its current (custom or default) content, for
// the Settings → Prompts page.
export async function listSystemPrompts(): Promise<SystemPromptView[]> {
  let rows: { key: string; content: string; updatedByEmail: string | null; updatedAt: Date }[] = [];
  let available = true;
  try {
    rows = await db.systemPrompt.findMany({
      select: { key: true, content: true, updatedByEmail: true, updatedAt: true },
    });
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    available = false;
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return SYSTEM_PROMPT_DEFS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      name: def.name,
      description: def.description,
      content: row?.content ?? def.default,
      source: row ? "custom" : "default",
      updatedByEmail: row?.updatedByEmail ?? null,
      updatedAt: row?.updatedAt ?? null,
      available,
    };
  });
}

// The built-in default for a key (used to reset).
export function defaultSystemPrompt(key: string): string | null {
  return DEF_BY_KEY.get(key)?.default ?? null;
}

export function isKnownPromptKey(key: string): boolean {
  return DEF_BY_KEY.has(key);
}

// Save (or clear) an override. Throws a friendly Error the route surfaces when
// the table isn't deployed yet.
export async function upsertSystemPrompt(key: string, content: string, updatedByEmail: string): Promise<void> {
  try {
    await db.systemPrompt.upsert({
      where: { key },
      update: { content, updatedByEmail },
      create: { key, content, updatedByEmail },
    });
  } catch (err) {
    if (isMissingTable(err)) {
      throw new Error("The system_prompts table isn't deployed yet — run db:deploy, then try again.");
    }
    throw err;
  }
}

// Reset a prompt to its built-in default by removing the override row.
export async function resetSystemPrompt(key: string): Promise<void> {
  try {
    await db.systemPrompt.deleteMany({ where: { key } });
  } catch (err) {
    if (isMissingTable(err)) return; // nothing stored → already at default
    throw err;
  }
}
