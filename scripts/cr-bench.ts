// =====================================================
// Change-request test bench — replay change requests offline, score the agent.
//
//   npx tsx scripts/cr-bench.ts                       every case, default model
//   npx tsx scripts/cr-bench.ts --case polybag-qty    one case (repeatable, or a,b)
//   npx tsx scripts/cr-bench.ts --model <id>          another model
//   npx tsx scripts/cr-bench.ts --out results.json    where the JSON goes
//                                                     (default /tmp/cr-bench-<timestamp>.json)
//   npx tsx scripts/cr-bench.ts --no-images           text-only proofs (no browser, fewer tokens)
//   npx tsx scripts/cr-bench.ts --score results.json  re-score saved outcomes, no API call
//
// Needs ANTHROPIC_API_KEY and nothing else — no database, no .env. Each case
// (scripts/cr-bench/cases/*.json) runs through the PRODUCTION pieces: the
// default system prompt (prompt.ts, without admin edits or memories), the
// production first message (job.ts buildFirstMessage) and the production loop
// (runAgentLoop) with the production client, model, effort and call budget.
// The tools are the production definitions (agent/tools.ts: names,
// descriptions, input schemas) with only their implementations swapped for
// fixture-backed ones (bench/fixture-tools.ts), so the agent reads the case's
// layout and styles and its drafts stay in memory. Then score.ts grades the
// hand-off against the case's `expected`.
//
// Proof pictures need Chromium: set PUPPETEER_EXECUTABLE_PATH (or have
// Puppeteer's own browser installed). Without one, render_proof sends a text
// reading of the proof instead and says so.
//
// See scripts/cr-bench/README.md for adding a case from a real request.
// =====================================================

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import {
  benchStyleData,
  loadBenchCases,
  type BenchCase,
  type LoadedBenchCase,
} from "@/lib/change-requests/bench/case-schema";
import {
  benchFirstMessage,
  fixtureImpact,
  fixtureTools,
  loadBenchRuntime,
  outcomeFromState,
  type FixtureState,
} from "@/lib/change-requests/bench/fixture-tools";
import { scoreCase, type BenchOutcome, type BenchScore } from "@/lib/change-requests/bench/score";
import {
  AiNotConfiguredError,
  agentEffort,
  agentModel,
  agentTaskBudget,
  getAgentClient,
  type AgentEffort,
} from "@/lib/change-requests/agent/client";
import type { ToolContext } from "@/lib/change-requests/agent/contract";
import { runAgentLoop, type AgentLoopResult } from "@/lib/change-requests/agent/loop";
import { DEFAULT_CHANGE_REQUEST_AGENT_PROMPT, buildSystemPrompt } from "@/lib/change-requests/agent/prompt";

const CASES_DIR = resolve(__dirname, "cr-bench/cases");

type CaseRun = {
  stopReason: AgentLoopResult["stopReason"] | "crashed";
  turns: number;
  toolCalls: { name: string; isError: boolean; durationMs: number }[];
  usage: AgentLoopResult["usage"] | null;
  costUsd: number | null;
  durationMs: number;
  finalText?: string;
  error?: string;
  refusalCategory?: string | null;
  memories: FixtureState["memories"];
};

type CaseResult = {
  id: string;
  title: string;
  expectedVerdict: BenchCase["expected"]["verdict"];
  outcome: BenchOutcome;
  score: BenchScore;
  run: CaseRun | null;
};

type BenchResults = {
  version: 1;
  startedAt: string;
  finishedAt: string;
  model: string | null;
  effort: AgentEffort | null;
  cases: CaseResult[];
  summary: { cases: number; meanScore: number; costUsd: number | null };
};

const USAGE = `Usage: npx tsx scripts/cr-bench.ts [--case <id>] [--model <id>] [--out <file>] [--no-images]
       npx tsx scripts/cr-bench.ts --score <results.json> [--out <file>]`;

async function main(): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    console.log(USAGE);
    return 0;
  }

  const all = loadBenchCases(CASES_DIR);
  const wanted = (args.values.case ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.some((l) => l.case.id === id));
  if (unknown.length) {
    console.error(`Unknown case ${unknown.join(", ")}. Cases: ${all.map((l) => l.case.id).join(", ")}`);
    return 2;
  }
  const selected = wanted.length ? all.filter((l) => wanted.includes(l.case.id)) : all;

  if (args.values.score) return rescore(args.values.score, selected, wanted.length > 0, args.values.out);

  // Fail fast and plainly on the one thing the bench needs.
  let client: Anthropic;
  try {
    client = getAgentClient();
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      console.error(
        "ANTHROPIC_API_KEY is not set. The bench runs the real model, so it needs an API key — and nothing else\n" +
          "(no database, no .env):\n\n  ANTHROPIC_API_KEY=sk-ant-… npx tsx scripts/cr-bench.ts\n\n" +
          "To re-score saved results without calling the API: npx tsx scripts/cr-bench.ts --score <results.json>",
      );
      return 2;
    }
    throw err;
  }

  const model = args.values.model?.trim() || agentModel();
  const effort = agentEffort();
  const out = args.values.out ?? `/tmp/cr-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const images = args.values["no-images"] ? "off" : "auto";
  const startedAt = new Date().toISOString();

  // The offline database stand-in goes in before job.ts (and everything it
  // imports) loads; the first message and the call budget then come from the
  // production job itself.
  await loadBenchRuntime(all.flatMap((l) => l.case.styles.flatMap((s) => benchStyleData(l.case, s.id).washSymbols)));
  const job = await import("@/lib/change-requests/agent/job");
  const system = buildSystemPrompt(DEFAULT_CHANGE_REQUEST_AGENT_PROMPT, []);

  console.error(`Bench: ${selected.length} case${selected.length === 1 ? "" : "s"} · ${model} · effort ${effort} · proofs ${images === "off" ? "text only" : "pictures when a browser is available"}`);
  const results: CaseResult[] = [];
  for (const loaded of selected) {
    const c = loaded.case;
    console.error(`\n▶ ${c.id} — ${c.title}`);
    const { tools, state } = await fixtureTools(c, { images });
    const ctx: ToolContext = {
      requestId: `bench:${c.id}`,
      outputId: "bench-output",
      userId: null,
      log: async (step) => console.error(`  · ${step.summary}`),
    };
    const started = Date.now();
    let run: CaseRun;
    try {
      const { content } = await benchFirstMessage(c, loaded.imagePaths);
      const result = await runAgentLoop({
        client,
        model,
        effort,
        system,
        userContent: content,
        tools,
        ctx,
        maxToolCalls: job.MAX_TOOL_CALLS,
        taskBudgetTokens: agentTaskBudget(),
        onTurn: (t) => {
          const prompt = t.usage.inputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens;
          console.error(
            `  turn ${t.turn} · ${t.toolCalls.length ? t.toolCalls.join(", ") : `stop: ${t.stopReason ?? "?"}`} · ` +
              `${prompt.toLocaleString("en")} in / ${t.usage.outputTokens.toLocaleString("en")} out` +
              (t.costUsd !== null ? ` · $${t.costUsd.toFixed(4)}` : "") +
              (t.fallback ? " · refusal fallback" : ""),
          );
        },
      });
      run = {
        stopReason: result.stopReason,
        turns: result.turns,
        toolCalls: result.calls.map((x) => ({ name: x.name, isError: x.isError, durationMs: x.durationMs })),
        usage: result.usage,
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
        ...(result.finalText ? { finalText: result.finalText } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.refusalCategory !== undefined ? { refusalCategory: result.refusalCategory } : {}),
        memories: state.memories,
      };
    } catch (err) {
      run = {
        stopReason: "crashed",
        turns: 0,
        toolCalls: [],
        usage: null,
        costUsd: null,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        memories: state.memories,
      };
    }
    const outcome = await withImpact(c, outcomeFromState(state));
    const score = scoreCase(c, outcome);
    console.error(`  → ${run.stopReason}${run.error ? ` (${run.error})` : ""} · score ${score.total} · ${score.notes.join("; ")}`);
    results.push({ id: c.id, title: c.title, expectedVerdict: c.expected.verdict, outcome, score, run });
  }

  const doc: BenchResults = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    model,
    effort,
    cases: results,
    summary: summary(results),
  };
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  printTable(results);
  console.log(`\nResults: ${out}`);
  return results.some((r) => r.run?.stopReason === "crashed") ? 1 : 0;
}

function parse() {
  return parseArgs({
    options: {
      case: { type: "string", multiple: true },
      model: { type: "string" },
      out: { type: "string" },
      score: { type: "string" },
      "no-images": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
}

// The render-based part of the score: which styles the handed-over draft
// changes. Offline — the fixture renderer, no browser needed.
async function withImpact(c: BenchCase, outcome: BenchOutcome): Promise<BenchOutcome> {
  const last = outcome.drafts[outcome.drafts.length - 1];
  if (!last) return outcome;
  try {
    const impact = await fixtureImpact(c, last.definition);
    return { ...outcome, impact: impact.rows.map((r) => ({ styleId: r.styleId, changed: r.changed })) };
  } catch (err) {
    console.error(`  (impact not computed: ${err instanceof Error ? err.message : String(err)})`);
    return outcome;
  }
}

async function rescore(file: string, cases: LoadedBenchCase[], filtered: boolean, out?: string): Promise<number> {
  let saved: BenchResults;
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as BenchResults;
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const byId = new Map(cases.map((l) => [l.case.id, l.case]));
  const results: CaseResult[] = [];
  for (const r of saved.cases ?? []) {
    const c = byId.get(r.id);
    if (!c) {
      if (!filtered) console.error(`Skipping ${r.id}: no such case any more`);
      continue;
    }
    // Impact is recomputed from the saved drafts: the case may have changed.
    const outcome = await withImpact(c, { ...r.outcome, impact: undefined });
    results.push({ ...r, title: c.title, expectedVerdict: c.expected.verdict, outcome, score: scoreCase(c, outcome) });
  }
  printTable(results);
  if (out) {
    const doc: BenchResults = { ...saved, cases: results, summary: summary(results) };
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`\nRe-scored results: ${out}`);
  }
  return 0;
}

function summary(results: CaseResult[]): BenchResults["summary"] {
  const costs = results.map((r) => r.run?.costUsd ?? null);
  return {
    cases: results.length,
    meanScore: results.length ? Math.round((results.reduce((s, r) => s + r.score.total, 0) / results.length) * 10) / 10 : 0,
    costUsd: costs.some((x) => x === null) ? null : Math.round(costs.reduce((s: number, x) => s + (x ?? 0), 0) * 1e4) / 1e4,
  };
}

function printTable(results: CaseResult[]): void {
  const rows = results.map((r) => {
    const s = r.score;
    const p = s.placement;
    return [
      r.id,
      s.verdictOk ? `${s.verdict} ✓` : `${s.verdict} ✗ (want ${r.expectedVerdict})`,
      p ? (p.found ? `${p.distance} ${p.withinTolerance ? "✓" : "✗"}` : "not found") : "–",
      String(s.warnings),
      String(s.total),
      r.run?.costUsd != null ? `$${r.run.costUsd.toFixed(4)}` : "–",
    ];
  });
  const head = ["case", "verdict", "placement", "warnings", "score", "cost"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  console.log(`\n${line(head)}\n${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const row of rows) console.log(line(row));
  const sum = summary(results);
  console.log(`\nmean score ${sum.meanScore} over ${sum.cases} case${sum.cases === 1 ? "" : "s"}${sum.costUsd !== null ? ` · total $${sum.costUsd.toFixed(4)}` : ""}`);
}

main()
  .then(async (code) => {
    // The shared Puppeteer browser would keep the process alive.
    await import("@/lib/pdf/renderer").then((r) => r.closeBrowser()).catch(() => undefined);
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
