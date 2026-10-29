import { test, before } from "node:test";
import assert from "node:assert/strict";
import { CHANGE_REQUEST_AGENT_PROMPT_KEY, DEFAULT_CHANGE_REQUEST_AGENT_PROMPT, buildSystemPrompt } from "./prompt";

// system-prompts.ts imports the db module; a dummy URL lets it load (no query runs).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";
let prompts: typeof import("@/lib/prompts/system-prompts");
before(async () => {
  prompts = await import("@/lib/prompts/system-prompts");
});

test("registered as an editable prompt under its fixed key", () => {
  const def = prompts.SYSTEM_PROMPT_DEFS.find((d) => d.key === CHANGE_REQUEST_AGENT_PROMPT_KEY);
  assert.ok(def, "change-request-agent is in SYSTEM_PROMPT_DEFS");
  assert.equal(def.default, DEFAULT_CHANGE_REQUEST_AGENT_PROMPT);
  assert.equal(prompts.isKnownPromptKey("change-request-agent"), true);
  assert.equal(prompts.defaultSystemPrompt("change-request-agent"), DEFAULT_CHANGE_REQUEST_AGENT_PROMPT);
});

test("the default covers the rules of design §5.7", () => {
  const p = DEFAULT_CHANGE_REQUEST_AGENT_PROMPT;
  const must: [RegExp, string][] = [
    [/red lines, arrows or boxes/, "markings show where to look"],
    [/"EXAMPLE"/, "example watermark"],
    [/style number, EAN, price/, "never copy example data"],
    [/output this run names and nothing else/, "only the named output"],
    [/existing token/, "prefer existing tokens"],
    [/get_output_settings/, "read the settings before drafting"],
    [/a carton EAN prints as EAN-13 by one setting on the output row/, "a symbology is a setting"],
    [/When the fix is a setting, do not draft\./, "a setting is not drafted"],
    [/\{\{barcode:cartonEan13\}\}/, "sources are listed"],
    [/\{\{if …\}\}/, "conditionals"],
    [/\{\{polybagQty\}\}/, "thresholds inside a variable"],
    [/declare_gap/, "code handoff"],
    [/Monday board and column/, "gap source"],
    [/fixed text/, "never fake a value"],
    [/render_proof/, "render every draft"],
    [/must NOT affect/, "a control style"],
    [/impact_list/, "impact check"],
    [/stock size/, "keep the stock size"],
    [/5 pt/, "minimum font size"],
    [/ask_reviewer/, "ask instead of guessing"],
    [/finish/, "hand over with finish"],
    [/plain language/, "plain-language summary"],
    [
      /If the reviewer only asked a question, or no layout change is needed or possible, answer with finish and explain — do not make a new draft\./,
      "an answer is not a draft",
    ],
  ];
  for (const [re, what] of must) assert.match(p, re, what);
});

test("not listed on Settings → Prompts while CHANGE_REQUESTS_ENABLED is off, but still registered", () => {
  const before = process.env.CHANGE_REQUESTS_ENABLED;
  try {
    delete process.env.CHANGE_REQUESTS_ENABLED;
    const off = prompts.listedPromptDefs().map((d) => d.key);
    assert.ok(!off.includes(CHANGE_REQUEST_AGENT_PROMPT_KEY));
    assert.ok(off.includes(prompts.REJECTION_FIX_PROMPT_KEY), "other prompts stay listed");
    // The job still reads it: known key, default content.
    assert.equal(prompts.isKnownPromptKey(CHANGE_REQUEST_AGENT_PROMPT_KEY), true);
    assert.equal(prompts.defaultSystemPrompt(CHANGE_REQUEST_AGENT_PROMPT_KEY), DEFAULT_CHANGE_REQUEST_AGENT_PROMPT);

    process.env.CHANGE_REQUESTS_ENABLED = "true";
    assert.ok(prompts.listedPromptDefs().some((d) => d.key === CHANGE_REQUEST_AGENT_PROMPT_KEY));
  } finally {
    if (before === undefined) delete process.env.CHANGE_REQUESTS_ENABLED;
    else process.env.CHANGE_REQUESTS_ENABLED = before;
  }
});

test("buildSystemPrompt joins the base and extra blocks, skipping empty ones", () => {
  assert.equal(buildSystemPrompt("  Base.  ", []), "Base.");
  assert.equal(buildSystemPrompt("Base.", ["", "  ", "Kept notes:\n- one"]), "Base.\n\nKept notes:\n- one");
});
