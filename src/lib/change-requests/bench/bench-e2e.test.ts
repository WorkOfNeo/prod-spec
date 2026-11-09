// The bench end to end, offline: a case's production first message, the
// production system prompt and the PRODUCTION loop (runAgentLoop), driven by a
// scripted fake client instead of the model, over the fixture tools — then
// scored. What scripts/cr-bench.ts does per case, minus the network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_TOOL_NAMES, type ToolContext } from "../agent/contract";
import { runAgentLoop, type AgentLoopClient } from "../agent/loop";
import { DEFAULT_CHANGE_REQUEST_AGENT_PROMPT, buildSystemPrompt } from "../agent/prompt";
import { loadBenchCase } from "./case-schema";
import { benchFirstMessage, fixtureImpact, fixtureTools, outcomeFromState } from "./fixture-tools";
import { scoreCase } from "./score";

delete process.env.DATABASE_URL;

type Params = Parameters<AgentLoopClient["beta"]["messages"]["stream"]>[0];
type Msg = Anthropic.Beta.BetaMessage;

const CASES = resolve(__dirname, "../../../../scripts/cr-bench/cases");
const SYSTEM = buildSystemPrompt(DEFAULT_CHANGE_REQUEST_AGENT_PROMPT, []);
const ctx: ToolContext = { requestId: "bench:e2e", outputId: "bench-output", userId: null, log: async () => {} };

function fakeClient(script: ((params: Params) => Msg)[]) {
  const requests: Params[] = [];
  let i = 0;
  const client: AgentLoopClient = {
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const step = script[i++];
          return {
            finalMessage: async () => {
              if (!step) throw new Anthropic.InternalServerError(500, undefined, "script exhausted", new Headers());
              return step(params);
            },
          };
        },
      },
    },
  };
  return { client, requests };
}

function msg(content: unknown[]): Msg {
  return {
    id: "msg_bench",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      fallback_credit: null,
      output_tokens_details: null,
    },
  } as unknown as Msg;
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

// The tool_result blocks the loop sent back on this request.
function results(p: Params) {
  const last = p.messages[p.messages.length - 1];
  return (last.content as { type: string; content?: unknown; is_error?: boolean }[]).filter((b) => b.type === "tool_result");
}

const tmp = mkdtempSync(join(tmpdir(), "cr-bench-e2e-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("polybag-qty: get_layout → propose_patch → proofs + impact → finish scores at least 90", async () => {
  const loaded = loadBenchCase(join(CASES, "polybag-qty.json"));
  const c = loaded.case;
  const { tools, state } = await fixtureTools(c, { images: "off" });
  const first = await benchFirstMessage(c, loaded.imagePaths);
  const firstText = (first.content[0] as { text: string }).text;
  assert.match(firstText, /This run works on ONE output: "Solid polybag sticker"/);
  assert.ok(firstText.includes(c.request.text));
  assert.match(firstText, /representative style id style-5pcs/);

  const { client, requests } = fakeClient([
    () => msg([use("t1", "get_layout", { layoutId: c.layout.id })]),
    (p) => {
      assert.match(String(results(p)[0].content), /"b-price"/);
      return msg([
        use("t2", "propose_patch", {
          layoutId: c.layout.id,
          note: "Pieces per polybag above the price",
          ops: [
            {
              op: "add_block",
              page: 0,
              block: {
                rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 },
                fontPt: 7,
                bold: true,
                align: "center",
                lines: ['{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}'],
              },
            },
          ],
        }),
      ]);
    },
    (p) => {
      assert.match(String(results(p)[0].content), /"revisionId":"bench-rev-1"/);
      return msg([
        use("t3", "render_proof", { revisionId: "bench-rev-1", styleId: "style-5pcs" }),
        use("t4", "render_proof", { revisionId: "bench-rev-1", styleId: "style-1pc", side: "after" }),
        use("t5", "impact_list", { revisionId: "bench-rev-1" }),
      ]);
    },
    (p) => {
      const r = results(p);
      assert.equal(r.length, 3, "all results of a turn in one message");
      assert.match(String(r[0].content), /5 PCS/);
      assert.doesNotMatch(String(r[1].content), /PCS/);
      assert.match(String(r[2].content), /"unchangedControls":\[\{"styleId":"style-1pc"/);
      return msg([use("t6", "finish", { summary: "The sticker now shows the pieces per polybag above the price when more than one." })]);
    },
  ]);

  const result = await runAgentLoop({
    client,
    model: "claude-opus-5-5",
    effort: "high",
    system: SYSTEM,
    userContent: first.content,
    tools,
    ctx,
    maxToolCalls: 30,
  });
  assert.equal(result.stopReason, "terminal");
  assert.equal(result.terminal?.name, "finish");
  assert.deepEqual(
    result.calls.map((x) => [x.name, x.isError]),
    [
      ["get_layout", false],
      ["propose_patch", false],
      ["render_proof", false],
      ["render_proof", false],
      ["impact_list", false],
      ["finish", false],
    ],
  );
  // The production prompt and every bench tool reached the "model".
  assert.equal(requests[0].system, SYSTEM);
  assert.equal(requests[0].tools?.length, AGENT_TOOL_NAMES.length);

  const outcome = outcomeFromState(state);
  const impact = await fixtureImpact(c, outcome.drafts[0].definition);
  const score = scoreCase(c, { ...outcome, impact: impact.rows });
  assert.ok(score.total >= 90, `score ${score.total}: ${score.notes.join("; ")}`);
  assert.equal(score.verdictOk, true);
  assert.equal(score.placement?.withinTolerance, true);
  assert.equal(score.controlUnchanged, true);
});

test("polybag-qty-gap: the token is missing, the agent hands over a gap and scores 100", async () => {
  const c = loadBenchCase(join(CASES, "polybag-qty-gap.json")).case;
  const { tools, state } = await fixtureTools(c, { images: "off" });
  const { client } = fakeClient([
    () => msg([use("t1", "list_tokens", { query: "polybag" })]),
    (p) => {
      assert.match(String(results(p)[0].content), /"count":0/);
      return msg([use("t2", "find_styles_by_value", { text: "Solid polybag" })]);
    },
    () =>
      msg([
        use("t3", "declare_gap", {
          tokenKey: "polybagQty",
          label: "Pieces per solid polybag",
          source: {
            board: "Styles",
            column: "Trims",
            examples: [
              { value: "Solid polybag- 5 Pcs / Polybag", count: 1 },
              { value: "Solid Polybag - 2 Pcs/ Polybag", count: 1 },
              { value: "1 pc individual polybag for solid", count: 1 },
            ],
          },
          rule: "The piece count of the solid polybag trim entry when it is above one; empty otherwise.",
          cases: [
            { input: "Solid polybag- 5 Pcs / Polybag", output: "5" },
            { input: "1 pc individual polybag for solid", output: "" },
          ],
        }),
      ]),
  ]);
  const result = await runAgentLoop({ client, model: "claude-opus-5-5", effort: "high", system: SYSTEM, userContent: "Fix it.", tools, ctx });
  assert.equal(result.stopReason, "terminal");
  const score = scoreCase(c, outcomeFromState(state));
  assert.equal(score.verdict, "gap");
  assert.equal(score.total, 100);
});

test("screenshots go into the first message as image blocks", async () => {
  // A 1×1 PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const file = join(tmp, "sticker-today.png");
  writeFileSync(file, png);
  const c = loadBenchCase(join(CASES, "polybag-qty.json")).case;
  const first = await benchFirstMessage(c, [file]);
  assert.equal(first.images, 1);
  const kinds = first.content.map((b) => b.type);
  assert.deepEqual(kinds, ["text", "text", "image"]);
  assert.equal((first.content[1] as { text: string }).text, "Screenshot 1: sticker-today.png");
  const img = first.content[2] as { source: { media_type: string; data: string } };
  assert.equal(img.source.media_type, "image/png");
  assert.equal(img.source.data, png.toString("base64"));
});
