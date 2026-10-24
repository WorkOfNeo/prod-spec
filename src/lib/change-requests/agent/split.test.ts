import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_NOT_CONFIGURED_NOTE,
  SPLIT_MODEL_DEFAULT,
  SplitError,
  UNMATCHED_LABEL,
  buildSplitPrompt,
  mapSplitResponse,
  splitRequestByOutput,
  type SplitClient,
} from "./split";

const OUTPUTS = [
  { variantKey: "layout:bogus-a", label: "Polybag sticker" },
  { variantKey: "care-label-02", label: "Care label" },
];
const EMAIL = "Hi! The polybag sticker needs the pack quantity. The care label font is too small. Thanks";

// A stand-in for the SDK client: records the params and answers what the test
// says the model answered.
function fakeClient(answer: Record<string, unknown> | (() => never)) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (typeof answer === "function") answer();
        return answer;
      },
    },
  } as unknown as SplitClient;
  return { client, calls };
}

let savedKey: string | undefined;
let savedModel: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedModel = process.env.CHANGE_REQUEST_SPLIT_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CHANGE_REQUEST_SPLIT_MODEL;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedModel === undefined) delete process.env.CHANGE_REQUEST_SPLIT_MODEL;
  else process.env.CHANGE_REQUEST_SPLIT_MODEL = savedModel;
});

test("without an API key the full text goes to every picked output, with a note", async () => {
  const res = await splitRequestByOutput({ text: `  ${EMAIL}  `, outputs: OUTPUTS });
  assert.deepEqual(res, {
    issues: [
      { variantKey: "layout:bogus-a", label: "Polybag sticker", text: EMAIL },
      { variantKey: "care-label-02", label: "Care label", text: EMAIL },
    ],
    note: AI_NOT_CONFIGURED_NOTE,
  });
});

test("nothing to split → no issues and no call", async () => {
  const { client, calls } = fakeClient({});
  assert.deepEqual(await splitRequestByOutput({ text: "   ", outputs: OUTPUTS }, { client }), { issues: [] });
  assert.deepEqual(await splitRequestByOutput({ text: EMAIL, outputs: [] }, { client }), { issues: [] });
  assert.equal(calls.length, 0);
});

test("the call: default model, structured output, low effort, no sampling knobs", async () => {
  const { client, calls } = fakeClient({ stop_reason: "end_turn", parsed_output: { issues: [], note: "" } });
  await splitRequestByOutput({ text: EMAIL, outputs: OUTPUTS }, { client });
  assert.equal(calls.length, 1);
  const p = calls[0] as {
    model: string;
    temperature?: unknown;
    system: string;
    messages: { role: string; content: string }[];
    output_config: { effort: string; format: { type: string; schema: unknown } };
  };
  assert.equal(p.model, SPLIT_MODEL_DEFAULT);
  assert.equal(p.temperature, undefined);
  assert.equal(p.output_config.effort, "low");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.ok(p.output_config.format.schema);
  // Outputs are numbered; the email is fenced as data.
  assert.match(p.messages[0].content, /1\. Polybag sticker\n2\. Care label/);
  assert.match(p.messages[0].content, /<request>\n[\s\S]*pack quantity[\s\S]*\n<\/request>/);
});

test("CHANGE_REQUEST_SPLIT_MODEL overrides the model", async () => {
  process.env.CHANGE_REQUEST_SPLIT_MODEL = "some-other-model";
  const { client, calls } = fakeClient({ stop_reason: "end_turn", parsed_output: { issues: [], note: "" } });
  await splitRequestByOutput({ text: EMAIL, outputs: OUTPUTS }, { client });
  assert.equal((calls[0] as { model: string }).model, "some-other-model");
});

test("the answer maps to one issue per output, in pick order, unmatched last", async () => {
  const { client } = fakeClient({
    stop_reason: "end_turn",
    parsed_output: {
      issues: [
        { output: 2, text: "The care label font is too small." },
        { output: 1, text: "The polybag sticker needs the pack quantity." },
        { output: 0, text: "Also the hangtag is wrong." },
        { output: 1, text: "  Only when more than 1 piece. " },
        { output: 7, text: "Out of range goes to unmatched." },
        { output: 2, text: "   " },
      ],
      note: " Hangtag is not picked. ",
    },
  });
  const res = await splitRequestByOutput({ text: EMAIL, outputs: OUTPUTS }, { client });
  assert.deepEqual(res, {
    issues: [
      {
        variantKey: "layout:bogus-a",
        label: "Polybag sticker",
        text: "The polybag sticker needs the pack quantity.\n\nOnly when more than 1 piece.",
      },
      { variantKey: "care-label-02", label: "Care label", text: "The care label font is too small." },
      {
        variantKey: null,
        label: UNMATCHED_LABEL,
        text: "Also the hangtag is wrong.\n\nOut of range goes to unmatched.",
      },
    ],
    note: "Hangtag is not picked.",
  });
});

test("mapSplitResponse drops repeated parts and an empty note", () => {
  const res = mapSplitResponse(
    {
      issues: [
        { output: 1, text: "Same sentence." },
        { output: 1, text: "Same sentence." },
      ],
      note: "",
    },
    OUTPUTS,
  );
  assert.deepEqual(res, { issues: [{ variantKey: "layout:bogus-a", label: "Polybag sticker", text: "Same sentence." }] });
});

test("a refusal, a cut-off answer or an unreadable answer is a SplitError", async () => {
  for (const answer of [
    { stop_reason: "refusal", parsed_output: null },
    { stop_reason: "max_tokens", parsed_output: null },
    { stop_reason: "end_turn", parsed_output: null },
  ]) {
    const { client } = fakeClient(answer);
    await assert.rejects(splitRequestByOutput({ text: EMAIL, outputs: OUTPUTS }, { client }), SplitError);
  }
});

test("API errors become a SplitError the form can show", async () => {
  const { client } = fakeClient(() => {
    throw new Anthropic.AnthropicError("Failed to parse structured output");
  });
  await assert.rejects(splitRequestByOutput({ text: EMAIL, outputs: OUTPUTS }, { client }), (err: unknown) => {
    assert.ok(err instanceof SplitError);
    assert.match(err.message, /could not be read/);
    return true;
  });
});

test("the prompt stays small and lists the outputs by number", () => {
  const { system, user } = buildSplitPrompt("text", OUTPUTS);
  assert.ok(system.length < 1200, `system prompt is ${system.length} chars`);
  assert.equal(user, "Outputs:\n1. Polybag sticker\n2. Care label\n\n<request>\ntext\n</request>");
});
