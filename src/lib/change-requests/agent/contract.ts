// =====================================================
// Change-request agent — the tool contract.
//
// Every action the agent takes goes through an AgentTool. Tools only READ and
// create DRAFTS (design §2): nothing behind this contract publishes, reruns,
// deletes, emails a supplier or touches SharePoint. Two callers share the same
// tool list so the trial and the in-app job behave identically:
//   - agent/job.ts turns each tool into a Messages API tool definition
//     (`z.toJSONSchema(tool.input)`) and runs the tool-use loop;
//   - scripts/cr-tools.ts exposes the same tools on the command line for the
//     Claude Code trial.
//
// This file is types + names only, so the tool implementations (agent/tools.ts)
// and the job can be built in parallel against it.
// =====================================================

import type { z } from "zod";

// The fixed tool names (design §5.7). tools.ts must implement exactly these.
export const AGENT_TOOL_NAMES = [
  "get_request",
  "find_styles_by_value",
  "find_layouts",
  "get_layout",
  "list_tokens",
  "get_cover",
  "propose_patch",
  "render_proof",
  "impact_list",
  "declare_gap",
  "ask_reviewer",
  "propose_memory",
  "finish",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

// Tools whose success ends the run: the agent has handed the request back to a
// person (a finished draft, a code handoff, or a question).
export const TERMINAL_TOOLS: ReadonlySet<AgentToolName> = new Set(["finish", "declare_gap", "ask_reviewer"]);

export type ToolImage = {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
  // Short label the job puts next to the image ("after · DSC-0001 · doc 1").
  caption?: string;
};

export type ToolResult = {
  // Sent to the model as the tool_result text; objects are JSON-stringified.
  content: string | Record<string, unknown> | unknown[];
  // Images returned to the model with the result (proofs for self-checking).
  images?: ToolImage[];
  // Sent as an error tool_result so the model can correct itself.
  isError?: boolean;
};

export type ToolContext = {
  requestId: string;
  // The output (issue) this run works on; null only for request-wide steps.
  outputId: string | null;
  // Who started the run; null when the cron sweep resumed it.
  userId: string | null;
  // Audit trail. The job persists these as ChangeRequestStep rows.
  log: (step: { kind: string; summary: string; detail?: Record<string, unknown> }) => Promise<void>;
};

export type AgentTool<I extends z.ZodType = z.ZodType> = {
  name: AgentToolName;
  // What it does and when to use it — written for the model.
  description: string;
  input: I;
  run: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolResult>;
};
