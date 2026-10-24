// scripts/cr-tools.ts — the change-request agent's tools on the command line,
// for the Claude Code trial (design docs/plans/change-requests.md §5, §5.7).
//
// The SAME tool list the in-app agent runs (src/lib/change-requests/agent/
// tools.ts), one call per invocation, so a Claude Code session can work a
// request by hand and the trial tests exactly what ships.
//
// Usage
//   npx tsx --env-file=.env scripts/cr-tools.ts list
//       Every tool: name, description and JSON input schema.
//   npx tsx --env-file=.env scripts/cr-tools.ts claim --output <id>
//       Claim the output for this session (status WORKING), as the in-app job
//       does at the start of a run. The writing tools (propose_patch,
//       ask_reviewer, declare_gap, propose_memory) refuse unless the output is
//       claimed, so a trial session starts here.
//   npx tsx --env-file=.env scripts/cr-tools.ts release '{"summary":"…"}' --output <id>
//       Hand the output back for review, as the job does when a run finishes:
//       IN_REVIEW, the summary posted in the thread (linked to the current
//       draft when there is one) and the draft counted. Skip it after
//       declare_gap / ask_reviewer — those hand the output back themselves.
//   npx tsx --env-file=.env scripts/cr-tools.ts <tool> '<json>' [--request <id>] [--output <id>] [--log]
//       Run one tool. <json> is its input (default {}). --output is the
//       change-request output (issue) the call works on; --request defaults
//       to that output's request. --log also writes ChangeRequestStep rows
//       (the request's audit trail), as the in-app job does.
//
// Output
//   stdout: the result as JSON — { tool, isError, content, images }.
//   stderr: what each tool logged, and the path of every image written.
//   Images (render_proof) are written to /tmp/cr-tools/<n>.png, numbered on
//   from the files already there; open them with the Read tool to look.
//   Exit code 0 = ok, 1 = the tool answered with an error, 2 = bad usage/input.
//
// A typical trial run on one output (ids from the /requests page):
//   cr-tools.ts claim --output <outputId>
//   cr-tools.ts get_request '{}' --output <outputId>
//   cr-tools.ts find_styles_by_value '{"text":"5 Pcs"}' --output <outputId>
//   cr-tools.ts find_layouts '{}' --output <outputId>
//   cr-tools.ts get_layout '{"layoutId":"<id>"}' --output <outputId>
//   cr-tools.ts list_tokens '{"query":"polybag"}' --output <outputId>
//   cr-tools.ts propose_patch '{"layoutId":"<id>","ops":[…],"note":"…"}' --output <outputId>
//   cr-tools.ts render_proof '{"revisionId":"<rev>","styleId":"<style>"}' --output <outputId>
//   cr-tools.ts impact_list '{"revisionId":"<rev>"}' --output <outputId>
//   cr-tools.ts release '{"summary":"…"}' --output <outputId>
//
// What it writes: propose_patch creates a DRAFT revision (never printed until
// an admin publishes it on the review screen); declare_gap / ask_reviewer move
// the output's status and post in the thread, and declare_gap emails the
// developer (simulated unless RESEND_EMAILS=true); propose_memory adds a
// PROPOSED note. Nothing here publishes, reruns or contacts a supplier.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { closeBrowser } from "@/lib/pdf/renderer";
import { appendMessage, logStep, rollUpRequestStatus, setOutputStatus } from "@/lib/change-requests/store";
import { CLAIMABLE_STATUSES } from "@/lib/change-requests/agent/job";
import { toolStepKind } from "@/lib/change-requests/types";
import type { ToolContext, ToolResult } from "@/lib/change-requests/agent/contract";
import { AGENT_TOOLS, toolByName } from "@/lib/change-requests/agent/tools";

const IMAGE_DIR = "/tmp/cr-tools";

type Args = { positional: string[]; request?: string; output?: string; log: boolean; help: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], log: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") out.log = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--request" || a === "--output") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new UsageError(`${a} needs an id`);
      if (a === "--request") out.request = v;
      else out.output = v;
    } else if (a.startsWith("--")) throw new UsageError(`Unknown flag ${a}`);
    else out.positional.push(a);
  }
  return out;
}

class UsageError extends Error {}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx --env-file=.env scripts/cr-tools.ts list",
    "  npx tsx --env-file=.env scripts/cr-tools.ts claim --output <id>",
    "  npx tsx --env-file=.env scripts/cr-tools.ts release '{\"summary\":\"…\"}' --output <id>",
    "  npx tsx --env-file=.env scripts/cr-tools.ts <tool> '<json>' [--request <id>] [--output <id>] [--log]",
    "",
    `Tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}`,
  ].join("\n");
}

// Next free /tmp/cr-tools/<n>.png number, so runs never overwrite each other.
function nextImageNumber(): number {
  let max = 0;
  try {
    for (const f of readdirSync(IMAGE_DIR)) {
      const m = /^(\d+)\.(png|jpe?g|webp)$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    // no directory yet
  }
  return max + 1;
}

function writeImages(images: NonNullable<ToolResult["images"]>): { path: string; caption?: string }[] {
  if (images.length === 0) return [];
  mkdirSync(IMAGE_DIR, { recursive: true });
  let n = nextImageNumber();
  return images.map((img) => {
    const ext = img.mediaType === "image/jpeg" ? "jpg" : img.mediaType === "image/webp" ? "webp" : "png";
    const file = path.join(IMAGE_DIR, `${n++}.${ext}`);
    writeFileSync(file, Buffer.from(img.base64, "base64"));
    return { path: file, ...(img.caption ? { caption: img.caption } : {}) };
  });
}

function excerpt(value: unknown, max = 2000): unknown {
  const s = JSON.stringify(value) ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : value;
}

// A trial session works an output the way the in-app job does: claim it
// (WORKING) so the writing tools accept calls, then hand it back for review.
async function claimOrRelease(name: "claim" | "release", rawInput: string | undefined, outputId: string | undefined): Promise<number> {
  if (!outputId) throw new UsageError(`${name} needs --output <id>`);
  const output = await db.changeRequestOutput.findUnique({
    where: { id: outputId },
    select: { id: true, requestId: true, status: true, currentRevisionId: true, draftCount: true },
  });
  if (!output) throw new UsageError(`Output ${outputId} not found.`);

  if (name === "claim") {
    const claimed = await db.changeRequestOutput.updateMany({
      where: { id: outputId, status: { in: [...CLAIMABLE_STATUSES] } },
      data: { status: "WORKING" },
    });
    if (claimed.count === 0) {
      console.log(JSON.stringify({ claimed: false, status: output.status, reason: "This output can't be claimed in its current status." }, null, 2));
      return 1;
    }
    await rollUpRequestStatus(output.requestId);
    await appendMessage({
      requestId: output.requestId,
      outputId,
      authorKind: "SYSTEM",
      kind: "status",
      body: "A trial session (Claude Code) is working on this output.",
    });
    console.log(JSON.stringify({ claimed: true, outputId }, null, 2));
    return 0;
  }

  if (output.status !== "WORKING") {
    console.log(JSON.stringify({ released: false, status: output.status, reason: "Only a claimed (WORKING) output can be released." }, null, 2));
    return 1;
  }
  let summary = "";
  if (rawInput !== undefined) {
    try {
      const parsed = z.object({ summary: z.string().max(4000) }).parse(JSON.parse(rawInput));
      summary = parsed.summary.trim();
    } catch (err) {
      throw new UsageError(`release takes '{"summary":"…"}': ${(err as Error).message}`);
    }
  }
  const draft = output.currentRevisionId
    ? await db.outputLayoutRevision.findUnique({
        where: { id: output.currentRevisionId },
        select: { id: true, status: true, changeRequestOutputId: true },
      })
    : null;
  const hasDraft = draft?.status === "DRAFT" && draft.changeRequestOutputId === outputId;
  await setOutputStatus(outputId, "IN_REVIEW", hasDraft ? { draftCount: { increment: 1 } } : {});
  if (summary) {
    await appendMessage({
      requestId: output.requestId,
      outputId,
      authorKind: "AGENT",
      kind: "message",
      body: summary,
      revisionId: hasDraft ? draft!.id : null,
    });
  }
  console.log(JSON.stringify({ released: true, status: "IN_REVIEW", draftId: hasDraft ? draft!.id : null }, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [name, rawInput] = args.positional;
  if (args.help || !name) {
    console.error(usage());
    return name || args.help ? 0 : 2;
  }

  if (name === "list") {
    const tools = AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input),
    }));
    console.log(JSON.stringify(tools, null, 2));
    return 0;
  }

  if (name === "claim" || name === "release") return claimOrRelease(name, rawInput, args.output);

  const tool = toolByName(name);
  if (!tool) throw new UsageError(`Unknown tool "${name}".`);

  let json: unknown = {};
  if (rawInput !== undefined) {
    try {
      json = JSON.parse(rawInput);
    } catch (err) {
      throw new UsageError(`The input is not valid JSON: ${(err as Error).message}`);
    }
  }
  const parsed = tool.input.safeParse(json);
  if (!parsed.success) {
    console.log(
      JSON.stringify(
        {
          tool: tool.name,
          isError: true,
          content: {
            error: `Invalid input for ${tool.name}`,
            issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
          },
        },
        null,
        2,
      ),
    );
    return 2;
  }

  // The request follows from the output when only --output is given.
  let requestId = args.request ?? "";
  const outputId = args.output ?? null;
  if (outputId && !requestId) {
    const row = await db.changeRequestOutput.findUnique({ where: { id: outputId }, select: { requestId: true } });
    if (!row) throw new UsageError(`Output ${outputId} not found.`);
    requestId = row.requestId;
  }
  if (args.log && !requestId) console.error("[cr-tools] --log needs --request or --output; steps are only printed.");
  const persist = args.log && !!requestId;

  const ctx: ToolContext = {
    requestId,
    outputId,
    userId: null,
    log: async (step) => {
      console.error(`[cr-tools] ${step.kind}: ${step.summary}`);
      if (persist) {
        await logStep({
          requestId,
          outputId,
          kind: step.kind,
          summary: step.summary,
          detail: step.detail as Prisma.InputJsonValue | undefined,
        });
      }
    },
  };

  const started = Date.now();
  const result = await tool.run(parsed.data, ctx);
  const durationMs = Date.now() - started;
  const isError = result.isError === true;
  const images = writeImages(result.images ?? []);
  for (const img of images) console.error(`[cr-tools] image: ${img.path}${img.caption ? ` (${img.caption})` : ""}`);

  // Mirror the in-app loop's mechanical row for the call itself.
  if (persist) {
    await logStep({
      requestId,
      outputId,
      kind: toolStepKind(tool.name),
      summary: `${tool.name}: ${isError ? "error" : "ok"} · ${durationMs} ms (cr-tools)`,
      detail: { input: excerpt(parsed.data), isError, durationMs, via: "cr-tools" } as Prisma.InputJsonValue,
    });
  }

  console.log(JSON.stringify({ tool: tool.name, isError, content: result.content, images }, null, 2));
  return isError ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${usage()}`);
      process.exitCode = 2;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  })
  .finally(async () => {
    await closeBrowser().catch(() => {});
    await db.$disconnect().catch(() => {});
  });
