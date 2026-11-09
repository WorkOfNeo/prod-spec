import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { z } from "zod";
import { anthropicUsageDetails, chatMessages, langfuseConfigured } from "@/lib/ai/tracing";
import { costUsd, tokenUsage } from "./client";

// =====================================================
// Split a pasted email into one issue per print output (design §5.7).
//
// Requests mostly arrive as an email that talks about several labels at once.
// The form asks for one issue per picked output, so "Split by output" sends the
// email and the picked outputs to a small, cheap model call and drops each
// part into the right textarea. The requester still reads and edits every
// issue before sending — this only saves the copy-paste.
//
// One structured-output call (the response is constrained to
// SplitResponseSchema), no tools, low effort. The model refers to outputs by
// their NUMBER in the list, never by key, so a garbled key can't route text to
// the wrong output; anything it can't place comes back unmatched.
//
// No ANTHROPIC_API_KEY → no call: every picked output gets the full text and a
// note says so. The form keeps working without AI.
//
// Traced in Langfuse as one `generation` ("split-request-email") with the
// prompt, the structured answer, usage and cost (src/lib/ai/tracing.ts).
// =====================================================

export const SPLIT_MODEL_DEFAULT = "claude-haiku-5-5";

export function splitModel(): string {
  return process.env.CHANGE_REQUEST_SPLIT_MODEL?.trim() || SPLIT_MODEL_DEFAULT;
}

export const AI_NOT_CONFIGURED_NOTE = "AI not configured — the text was copied to every output";
export const UNMATCHED_LABEL = "Not about a picked output";

export type SplitOutputRef = { variantKey: string; label: string };
export type SplitIssue = { variantKey: string | null; label: string; text: string };
export type SplitResult = { issues: SplitIssue[]; note?: string };

// What the model must answer. `output` is the 1-based number from the list,
// 0 for text that is about none of them. A plain number (not .int(), whose
// safe-integer bounds would be spelled out in the schema); mapSplitResponse
// treats anything that isn't a listed number as unmatched.
export const SplitResponseSchema = z.object({
  issues: z.array(
    z.object({
      output: z.number().describe("The output's number from the list, or 0 when it fits none of them"),
      text: z.string(),
    }),
  ),
  note: z.string(),
});
export type SplitResponse = z.infer<typeof SplitResponseSchema>;

// The model call failed in a way the requester should hear about (and can fix
// by splitting by hand). Routes answer 502 with the message.
export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

const SYSTEM_PROMPT = [
  "You sort a change request for printed labels and packaging by the print output it is about.",
  "The request is often a pasted email and may be in any language.",
  "- Return one issue per listed output the text asks to change, with that output's number.",
  "- Copy the sentences about that output as written, in the original language. Do not translate, summarise or add anything.",
  "- A sentence that applies to several outputs goes into each of them.",
  "- Text that asks for a change but fits none of the outputs goes into an issue with output 0.",
  "- Leave out greetings, signatures and small talk.",
  "- note: one short sentence for the person filling in the form when something is unclear, otherwise an empty string.",
].join("\n");

export function buildSplitPrompt(text: string, outputs: readonly SplitOutputRef[]): { system: string; user: string } {
  const list = outputs.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  return {
    system: SYSTEM_PROMPT,
    user: `Outputs:\n${list}\n\n<request>\n${text}\n</request>`,
  };
}

// The fallback: the whole text on every picked output.
export function copyToEveryOutput(text: string, outputs: readonly SplitOutputRef[], note?: string): SplitResult {
  return {
    issues: outputs.map((o) => ({ variantKey: o.variantKey, label: o.label, text })),
    ...(note ? { note } : {}),
  };
}

// Model answer → one issue per output, in the order the outputs were picked
// (several parts for one output are joined), then whatever fit none of them.
export function mapSplitResponse(response: SplitResponse, outputs: readonly SplitOutputRef[]): SplitResult {
  const perOutput = new Map<number, string[]>();
  const unmatched: string[] = [];
  for (const issue of response.issues) {
    const text = issue.text.trim();
    if (!text) continue;
    const index = issue.output - 1;
    if (Number.isInteger(index) && index >= 0 && index < outputs.length) {
      const parts = perOutput.get(index) ?? [];
      if (!parts.includes(text)) parts.push(text);
      perOutput.set(index, parts);
    } else {
      unmatched.push(text);
    }
  }
  const issues: SplitIssue[] = [];
  outputs.forEach((o, i) => {
    const parts = perOutput.get(i);
    if (parts?.length) issues.push({ variantKey: o.variantKey, label: o.label, text: parts.join("\n\n") });
  });
  if (unmatched.length > 0) issues.push({ variantKey: null, label: UNMATCHED_LABEL, text: unmatched.join("\n\n") });
  const note = response.note.trim();
  return note ? { issues, note } : { issues };
}

// The slice of the SDK client this module uses — tests pass a stand-in.
export type SplitClient = Pick<Anthropic, "messages">;

export async function splitRequestByOutput(
  input: { text: string; outputs: SplitOutputRef[] },
  deps: { client?: SplitClient; userId?: string } = {},
): Promise<SplitResult> {
  const text = input.text.trim();
  if (!text || input.outputs.length === 0) return { issues: [] };
  if (!deps.client && !process.env.ANTHROPIC_API_KEY) {
    return copyToEveryOutput(text, input.outputs, AI_NOT_CONFIGURED_NOTE);
  }

  // The SDK's own OpenTelemetry spans are off: the call is traced below.
  const client = deps.client ?? new Anthropic({ openTelemetry: false });
  const prompt = buildSplitPrompt(text, input.outputs);
  const model = splitModel();
  return propagateAttributes(
    {
      traceName: "split-request-email",
      tags: ["change-requests"],
      ...(deps.userId ? { userId: deps.userId } : {}),
      metadata: { outputs: String(input.outputs.length) },
    },
    () =>
      startActiveObservation(
        "split-request-email",
        async (generation) => {
          generation.update({
            model,
            modelParameters: { effort: "low", max_tokens: 16000 },
            ...(langfuseConfigured()
              ? { input: chatMessages(prompt.system, [{ role: "user", content: prompt.user }]) }
              : {}),
          });
          const fail = (message: string) => {
            generation.update({ level: "ERROR", statusMessage: message });
            return new SplitError(message);
          };

          let response;
          try {
            response = await client.messages.parse({
              model,
              max_tokens: 16000,
              system: prompt.system,
              messages: [{ role: "user", content: prompt.user }],
              output_config: { effort: "low", format: zodOutputFormat(SplitResponseSchema) },
            });
          } catch (err) {
            if (err instanceof Anthropic.RateLimitError) {
              throw fail("The AI is busy right now — try again in a minute, or split the text by hand.");
            }
            if (err instanceof Anthropic.APIError) {
              throw fail(`The AI could not split this text (${err.status ?? "network error"}) — split it by hand.`);
            }
            // A structured answer that didn't parse surfaces as a plain AnthropicError.
            if (err instanceof Anthropic.AnthropicError) {
              throw fail("The AI answer could not be read — try again, or split the text by hand.");
            }
            throw err;
          }

          const usage = response.usage ? tokenUsage(response.usage) : null;
          const cost = usage ? costUsd(response.model ?? model, usage) : null;
          generation.update({
            model: response.model ?? model,
            output: response.parsed_output ?? null,
            ...(usage ? { usageDetails: anthropicUsageDetails(usage) } : {}),
            ...(cost !== null ? { costDetails: { total: cost } } : {}),
            metadata: { stopReason: response.stop_reason },
          });

          if (response.stop_reason === "refusal") {
            throw fail("The AI declined to split this text — split it by hand.");
          }
          if (response.stop_reason === "max_tokens") {
            throw fail("The text is too long to split in one go — split it by hand.");
          }
          if (!response.parsed_output) {
            throw fail("The AI answer could not be read — try again, or split the text by hand.");
          }
          return mapSplitResponse(response.parsed_output, input.outputs);
        },
        { asType: "generation" },
      ),
  );
}
