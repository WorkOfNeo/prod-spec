import { test, before } from "node:test";
import assert from "node:assert/strict";

// The pure half of agent memory: labels, grouping, the prompt block, the state
// machine and the follow-along log. The DB half is driven through the routes
// in tests/agent-memory-routes.test.ts.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let m: typeof import("./memory");
before(async () => {
  m = await import("./memory");
});

// ---- labels ---------------------------------------------------------------

test("source label: request number + where it came from, in plain words", () => {
  assert.equal(m.sourceLabel("CORRECTION", 1), "R-0001 · your correction");
  assert.equal(m.sourceLabel("AGENT_FINDING", 42), "R-0042 · the agent noticed");
  assert.equal(m.sourceLabel("MANUAL", null), "added by hand");
  // An unknown kind still renders instead of crashing the page.
  assert.equal(m.sourceLabel("SOMETHING_NEW", undefined), "something_new");
});

test("scope label: names the customer and the doc type, never shows a raw id", () => {
  const names = new Map([["cust-1", "Example Retail"]]);
  assert.equal(m.scopeLabel("GLOBAL", null, names), "Everywhere");
  assert.equal(m.scopeLabel("CUSTOMER", "cust-1", names), "Customer · Example Retail");
  assert.equal(m.scopeLabel("CUSTOMER", "bogus-id", names), "Customer");
  assert.equal(m.scopeLabel("DOC_TYPE", "WASHCARE"), "Doc type · Wash care");
  assert.equal(m.scopeLabel("DOC_TYPE", "NEW_THING"), "Doc type · New Thing");
  assert.equal(m.scopeLabel("MONDAY", "board-1"), "Monday data");
});

// ---- grouping + prompt ----------------------------------------------------

test("grouping follows scope order, drops empty and unknown scopes, keeps input order", () => {
  const notes = [
    { id: "a", scope: "MONDAY" },
    { id: "b", scope: "GLOBAL" },
    { id: "c", scope: "WHATEVER" },
    { id: "d", scope: "GLOBAL" },
    { id: "e", scope: "DOC_TYPE" },
  ];
  const groups = m.groupMemoriesByScope(notes);
  assert.deepEqual(
    groups.map((g) => [g.scope, g.notes.map((n) => n.id)]),
    [
      ["GLOBAL", ["b", "d"]],
      ["DOC_TYPE", ["e"]],
      ["MONDAY", ["a"]],
    ],
  );
});

test("prompt block: one heading per scope, a bullet per note, multi-line notes indented", () => {
  const text = m.formatMemoriesForPrompt([
    { scope: "CUSTOMER", text: "Quantities are printed in bold." },
    { scope: "GLOBAL", text: "  Never go below 5 pt.  " },
    { scope: "CUSTOMER", text: "Polybag stickers say PCS,\nnot PIECES." },
    { scope: "MONDAY", text: "The size column can hold a range like 2-4." },
  ]);
  assert.equal(
    text,
    [
      "## Notes: general",
      "- Never go below 5 pt.",
      "",
      "## Notes: this customer",
      "- Quantities are printed in bold.",
      "- Polybag stickers say PCS,",
      "  not PIECES.",
      "",
      "## Notes: Monday data",
      "- The size column can hold a range like 2-4.",
    ].join("\n"),
  );
});

test("prompt block: nothing kept → empty string, blank notes are skipped", () => {
  assert.equal(m.formatMemoriesForPrompt([]), "");
  assert.equal(m.formatMemoriesForPrompt([{ scope: "GLOBAL", text: "   " }]), "");
});

// ---- state machine --------------------------------------------------------

test("transitions: keep/dismiss a suggestion, forget a kept note, restore closed ones", () => {
  assert.ok(m.canTransition("PROPOSED", "KEPT"));
  assert.ok(m.canTransition("PROPOSED", "DISMISSED"));
  assert.ok(m.canTransition("KEPT", "FORGOTTEN"));
  assert.ok(m.canTransition("DISMISSED", "PROPOSED"));
  assert.ok(m.canTransition("DISMISSED", "KEPT"));
  assert.ok(m.canTransition("FORGOTTEN", "KEPT"));
  // Same state is an idempotent no-op.
  assert.ok(m.canTransition("KEPT", "KEPT"));

  assert.equal(m.canTransition("PROPOSED", "FORGOTTEN"), false);
  assert.equal(m.canTransition("KEPT", "DISMISSED"), false);
  assert.equal(m.canTransition("KEPT", "PROPOSED"), false);
  assert.equal(m.canTransition("FORGOTTEN", "DISMISSED"), false);
  assert.equal(m.canTransition("GARBAGE", "KEPT"), false);
});

test("restore undoes the last close: dismissed → suggestion, forgotten → kept", () => {
  assert.equal(m.restoreTarget("DISMISSED"), "PROPOSED");
  assert.equal(m.restoreTarget("FORGOTTEN"), "KEPT");
  assert.equal(m.restoreTarget("KEPT"), null);
  assert.equal(m.restoreTarget("PROPOSED"), null);
  for (const s of ["DISMISSED", "FORGOTTEN"]) assert.ok(m.canTransition(s, m.restoreTarget(s)!));
});

test("plan: an empty patch is refused", () => {
  const plan = m.planMemoryUpdate({ state: "KEPT", text: "x" }, {});
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.code, "empty");
});

test("plan: text is trimmed, line endings normalised, and only written when it changed", () => {
  const plan = m.planMemoryUpdate({ state: "KEPT", text: "old" }, { text: "  new\r\nline  " });
  assert.deepEqual(plan, { ok: true, changed: true, data: { text: "new\nline" } });
  const same = m.planMemoryUpdate({ state: "KEPT", text: "same" }, { text: " same " });
  assert.deepEqual(same, { ok: true, changed: false, data: {} });
});

test("plan: empty or over-long text is refused; closed notes can't be edited", () => {
  const blank = m.planMemoryUpdate({ state: "KEPT", text: "x" }, { text: "   " });
  assert.equal(!blank.ok && blank.code, "invalid_text");
  const long = m.planMemoryUpdate({ state: "KEPT", text: "x" }, { text: "a".repeat(m.MEMORY_TEXT_MAX + 1) });
  assert.equal(!long.ok && long.code, "invalid_text");
  const atMax = m.planMemoryUpdate({ state: "KEPT", text: "x" }, { text: "a".repeat(m.MEMORY_TEXT_MAX) });
  assert.equal(atMax.ok, true);
  for (const state of ["DISMISSED", "FORGOTTEN"]) {
    const closed = m.planMemoryUpdate({ state, text: "x" }, { text: "y" });
    assert.equal(!closed.ok && closed.code, "not_editable", state);
  }
  // A suggestion can be reworded before it is kept.
  assert.equal(m.planMemoryUpdate({ state: "PROPOSED", text: "x" }, { text: "y" }).ok, true);
});

test("plan: a forbidden move says so in words; a same-state move changes nothing", () => {
  const bad = m.planMemoryUpdate({ state: "KEPT", text: "x" }, { state: "DISMISSED" });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.code, "invalid_transition");
  assert.equal(!bad.ok && bad.message, "A kept note can't become dismissed.");
  assert.deepEqual(m.planMemoryUpdate({ state: "KEPT", text: "x" }, { state: "KEPT" }), {
    ok: true,
    changed: false,
    data: {},
  });
});

test("plan: reword and keep in one go", () => {
  const plan = m.planMemoryUpdate({ state: "PROPOSED", text: "draft" }, { state: "KEPT", text: "final" });
  assert.deepEqual(plan, { ok: true, changed: true, data: { text: "final", state: "KEPT" } });
});

// ---- follow-along log -----------------------------------------------------

const base = {
  id: "mem-1",
  text: "note",
  scopeLabel: "Everywhere",
  sourceLabel: "R-0001 · your correction",
  lastUsedAt: null as Date | null,
};

test("log event: the state is the event, labelled for people", () => {
  const at = new Date("2026-10-24T10:00:00Z");
  const kinds = ["PROPOSED", "KEPT", "DISMISSED", "FORGOTTEN"].map(
    (state) => m.memoryEvent({ ...base, state, updatedAt: at }).label,
  );
  assert.deepEqual(kinds, ["Suggested", "Kept", "Dismissed", "Forgotten"]);
  const ev = m.memoryEvent({ ...base, state: "KEPT", updatedAt: at });
  assert.equal(ev.when, at);
  assert.equal(ev.source, "R-0001 · your correction");
});

test("log event: a prompt read (lastUsedAt === updatedAt) shows as 'Read by the agent'", () => {
  const at = new Date("2026-10-24T10:00:00Z");
  const used = m.memoryEvent({ ...base, state: "KEPT", updatedAt: at, lastUsedAt: new Date(at) });
  assert.equal(used.kind, "used");
  assert.equal(used.label, "Read by the agent");
  // Used earlier, then forgotten: the forget is the latest event.
  const later = new Date("2026-10-24T11:00:00Z");
  assert.equal(m.memoryEvent({ ...base, state: "FORGOTTEN", updatedAt: later, lastUsedAt: at }).kind, "forgotten");
  // Used earlier, then re-kept/edited: shows as kept.
  assert.equal(m.memoryEvent({ ...base, state: "KEPT", updatedAt: later, lastUsedAt: at }).kind, "kept");
});

// ---- a note written by hand ------------------------------------------------

test("new note: trimmed text, the scope's reference kept only where it means something", () => {
  assert.deepEqual(m.planNewMemory({ scope: "MONDAY", scopeRef: "ignored", text: "  Certificates drive the cert marks.\r\n" }), {
    ok: true,
    data: { scope: "MONDAY", scopeRef: null, text: "Certificates drive the cert marks." },
  });
  assert.deepEqual(m.planNewMemory({ scope: "CUSTOMER", scopeRef: " cust-1 ", text: "Bold quantities." }), {
    ok: true,
    data: { scope: "CUSTOMER", scopeRef: "cust-1", text: "Bold quantities." },
  });
  assert.deepEqual(m.planNewMemory({ scope: "DOC_TYPE", scopeRef: "WASHCARE", text: "x" }), {
    ok: true,
    data: { scope: "DOC_TYPE", scopeRef: "WASHCARE", text: "x" },
  });
});

test("new note: refused without text, past the limit, with an unknown scope or a missing customer/doc type", () => {
  const code = (input: Parameters<typeof m.planNewMemory>[0]) => {
    const plan = m.planNewMemory(input);
    return plan.ok ? "ok" : plan.code;
  };
  assert.equal(code({ scope: "GLOBAL", text: "   " }), "invalid_text");
  assert.equal(code({ scope: "GLOBAL", text: "x".repeat(m.MEMORY_TEXT_MAX + 1) }), "invalid_text");
  assert.equal(code({ scope: "EVERYTHING", text: "x" }), "invalid_scope");
  assert.equal(code({ scope: "CUSTOMER", text: "x" }), "invalid_scope");
  assert.equal(code({ scope: "DOC_TYPE", scopeRef: "  ", text: "x" }), "invalid_scope");
});
