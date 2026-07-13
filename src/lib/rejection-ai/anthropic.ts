// =====================================================
// Minimal raw-fetch client for the Anthropic Messages API.
//
// The app has no AI SDK dependency, and this is the only call site, so a thin
// fetch wrapper keeps the footprint to zero new packages. Targets Claude Haiku
// 4.5 — cheap and fast, which suits a bounded JSON-editing task. Set
// ANTHROPIC_API_KEY in the environment (Railway) to enable it.
// =====================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Cheap, fast, JSON-capable — the right tier for constrained line edits.
const MODEL = "claude-haiku-4-5";

// Thrown when the API key isn't configured — the route turns this into a clear
// "set ANTHROPIC_API_KEY" message rather than a generic 500.
export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI is not configured — set ANTHROPIC_API_KEY in the environment to enable AI fixes.");
    this.name = "AiNotConfiguredError";
  }
}

// Thrown when Claude replies but the text isn't the JSON object we asked for.
export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}

type ClaudeTextBlock = { type: string; text?: string };
type ClaudeResponse = { content?: ClaudeTextBlock[] };

// Pull a single JSON object out of the model's text. Tolerates markdown
// fences and any stray prose around the object by taking the first "{" to the
// last "}". Returns a plain object; the caller validates the shape.
function extractJsonObject(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AiResponseError("AI response did not contain a JSON object.");
  }
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new AiResponseError("AI response was not valid JSON.");
  }
}

// Call Claude with a system prompt + a single user message and return the
// parsed JSON object from its reply. `system` is the (editable) guidance; the
// strict output contract belongs at the end of `user`, where response-shaping
// instructions land best.
export async function callClaudeForJson(input: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiNotConfiguredError();

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Surface the status; the reviewer only needs "it failed, try again".
    throw new AiResponseError(`Claude API error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const data = (await res.json()) as ClaudeResponse;
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  if (!text.trim()) throw new AiResponseError("AI returned an empty response.");
  return extractJsonObject(text);
}
