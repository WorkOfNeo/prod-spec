// =====================================================
// Change-request bench — scoring one run against a case.
//
// scoreCase() grades what the agent handed back (its hand-off call, its
// drafts, the warnings on the draft it handed over and — when the caller
// rendered it — which fixture styles that draft changes) against the case's
// `expected`. Pure: no rendering, no I/O. The render-based part (does the
// control style change?) comes in precomputed as `outcome.impact`, which
// scripts/cr-bench.ts fills from fixtureImpact().
//
// Components and weights (points out of 100):
//
//   expected patch     verdict 40 · tokens 20 · placement 25 · control 15
//   expected gap       verdict 60 · gap token key 40
//   expected question  verdict 100
//
// A component the case doesn't ask for (no expected.block → no placement; no
// mustNotChangeStyleIds → no control check; no tokensUsed → no token check)
// is dropped and the remaining weights are scaled up to 100, so cases with
// fewer expectations still score on the same 0–100 scale. Then:
//
//   warnings  −2 per warning on the handed-over draft, at most −10 — the
//             agent should have looked at the proof and fixed an overlap or
//             overflow before handing over.
//
// The verdict is read off the hand-off: finish WITH a draft = patch,
// declare_gap = gap, ask_reviewer = question; finish without a draft, or no
// hand-off at all (call budget, refusal, error), = none.
//
// Tokens (patch): every expected entry must appear in the lines the final
// draft adds or changes — as a {{token}}, an {{if token …}} field or a calc
// field. An entry may list alternatives, "composition|compositionLines".
//
// Placement (patch): among the blocks the final draft adds or changes on the
// expected page, those whose lines contain every `lineIncludes` substring are
// candidates; the closest one counts. distance = |Δcol| + |Δrow| + |ΔcolSpan|
// + |ΔrowSpan| in grid cells. Within tolerance it earns from the full weight
// (exact) down to half (at the tolerance) linearly; outside it earns nothing.
// Not found → distance −1.
//
// Gap token key: the declared tokenKey matches when it equals the expected
// key (case-insensitive) OR contains the expected key's last camel-case word,
// case-insensitive — for "polybagQty" any key containing "qty" ("qtyPerPolybag",
// "solidPolybagQty") counts, since the name is the developer's call and the
// point is that the agent asked for the quantity rather than faking it.
// =====================================================

import { calcsInLine, fieldsInCalcExpression } from "@/lib/output-layouts/calc";
import { conditionalsInLine, tokensInLine, type LayoutBlock, type LayoutDef } from "@/lib/output-layouts/schema";
import type { BenchCase, BenchVerdict } from "./case-schema";

export const SCORE_WEIGHTS = {
  patch: { verdict: 40, tokens: 20, placement: 25, control: 15 },
  gap: { verdict: 60, gapKey: 40 },
  question: { verdict: 100 },
} as const;
export const WARNING_PENALTY = 2;
export const MAX_WARNING_PENALTY = 10;

export type BenchOutcome = {
  // The hand-off call that ended the run, if any.
  terminal?: { name: string; input: unknown };
  // Every draft the run made, oldest first; the last one is what was handed over.
  drafts: { definition: LayoutDef; ops: unknown[] }[];
  // Warnings applyLayoutOps reported on the handed-over (last) draft.
  warnings: string[];
  // Per fixture style: does the last draft change its document? (render-based)
  impact?: { styleId: string; changed: boolean }[];
};

export type GotVerdict = BenchVerdict | "none";

export type Placement = { found: boolean; distance: number; withinTolerance: boolean };

export type BenchScore = {
  verdict: GotVerdict;
  verdictOk: boolean;
  tokensOk: boolean;
  placement?: Placement;
  controlUnchanged?: boolean;
  warnings: number;
  // 0..100
  total: number;
  notes: string[];
};

// ── Helpers shared with the fixture tools ───────────────────────────────────

// Every field a line reads: {{tokens}}, {{if field …}} conditions and the
// fields of {{= calc }} expressions.
export function lineTokenKeys(line: string): string[] {
  const keys = new Set<string>();
  for (const ref of tokensInLine(line)) keys.add(ref.key);
  for (const c of conditionalsInLine(line)) keys.add(c.field);
  for (const expr of calcsInLine(line)) {
    const { fields, aggregates } = fieldsInCalcExpression(expr);
    for (const f of [...fields, ...aggregates]) keys.add(f);
  }
  return [...keys];
}

export function verdictOf(outcome: Pick<BenchOutcome, "terminal" | "drafts">): GotVerdict {
  switch (outcome.terminal?.name) {
    case "finish":
      return outcome.drafts.length > 0 ? "patch" : "none";
    case "declare_gap":
      return "gap";
    case "ask_reviewer":
      return "question";
    default:
      return "none";
  }
}

export function gapKeyMatches(declared: string, expected: string): boolean {
  const d = declared.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!d || !e) return false;
  if (d === e) return true;
  const words = expected.trim().split(/(?=[A-Z])/).filter(Boolean);
  const last = (words[words.length - 1] ?? expected).toLowerCase();
  return d.includes(last);
}

export type ChangedBlock = { page: number; block: LayoutBlock; added: boolean; newLines: string[] };

// Blocks the draft adds, or whose lines or rect differ from the base, with the
// lines that are new (not anywhere in the base block).
export function changedBlocks(base: LayoutDef, draft: LayoutDef): ChangedBlock[] {
  const out: ChangedBlock[] = [];
  draft.pages.forEach((page, pageIndex) => {
    const before = new Map((base.pages[pageIndex]?.blocks ?? []).map((b) => [b.id, b]));
    for (const block of page.blocks) {
      const prev = block.id ? before.get(block.id) : undefined;
      if (!prev) {
        out.push({ page: pageIndex, block, added: true, newLines: [...block.lines] });
        continue;
      }
      const oldLines = new Set(prev.lines);
      const newLines = block.lines.filter((l) => !oldLines.has(l));
      const linesChanged = newLines.length > 0 || prev.lines.length !== block.lines.length;
      if (linesChanged || JSON.stringify(prev.rect) !== JSON.stringify(block.rect)) {
        out.push({ page: pageIndex, block, added: false, newLines });
      }
    }
  });
  return out;
}

function rectDistance(
  a: { col: number; row: number; colSpan: number; rowSpan: number },
  b: { col: number; row: number; colSpan: number; rowSpan: number },
): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) + Math.abs(a.colSpan - b.colSpan) + Math.abs(a.rowSpan - b.rowSpan);
}

// ── scoreCase ────────────────────────────────────────────────────────────────

export function scoreCase(benchCase: BenchCase, outcome: BenchOutcome): BenchScore {
  const expected = benchCase.expected;
  const notes: string[] = [];
  const verdict = verdictOf(outcome);
  const verdictOk = verdict === expected.verdict;
  notes.push(
    verdictOk
      ? `verdict ${verdict} as expected`
      : `verdict ${verdict}, expected ${expected.verdict}` +
          (outcome.terminal?.name === "finish" && outcome.drafts.length === 0 ? " (finished without a draft)" : ""),
  );

  const finalDraft = outcome.drafts.length ? outcome.drafts[outcome.drafts.length - 1] : null;
  const changes = finalDraft ? changedBlocks(benchCase.layout.definition, finalDraft.definition) : [];
  const warnings = finalDraft ? outcome.warnings.length : 0;

  let earned = 0;
  let possible = 0;
  const component = (weight: number, fraction: number) => {
    possible += weight;
    earned += weight * Math.max(0, Math.min(1, fraction));
  };

  let tokensOk = true;
  let placement: Placement | undefined;
  let controlUnchanged: boolean | undefined;

  if (expected.verdict === "patch") {
    const w = SCORE_WEIGHTS.patch;
    component(w.verdict, verdictOk ? 1 : 0);

    if (expected.tokensUsed?.length) {
      const used = new Set(changes.flatMap((c) => c.newLines.flatMap(lineTokenKeys)));
      const missing = expected.tokensUsed.filter((entry) => !entry.split("|").some((k) => used.has(k.trim())));
      tokensOk = !!finalDraft && missing.length === 0;
      component(w.tokens, tokensOk ? 1 : 0);
      if (!finalDraft) notes.push("tokens: no draft");
      else if (missing.length) notes.push(`tokens missing from the changed lines: ${missing.join(", ")}`);
      else notes.push(`tokens used: ${expected.tokensUsed.join(", ")}`);
    }

    if (expected.block) {
      const b = expected.block;
      const includes = b.lineIncludes ?? [];
      const candidates = changes.filter(
        (c) => c.page === b.page && c.block.rect && includes.every((s) => c.block.lines.join("\n").includes(s)),
      );
      if (!candidates.length) {
        placement = { found: false, distance: -1, withinTolerance: false };
        component(w.placement, 0);
        notes.push(
          finalDraft
            ? `placement: no added or changed block on page ${b.page} with ${includes.map((s) => JSON.stringify(s)).join(" + ") || "any lines"}`
            : "placement: no draft",
        );
      } else {
        const distance = Math.min(...candidates.map((c) => rectDistance(c.block.rect!, b.rect)));
        const withinTolerance = distance <= b.tolerance;
        placement = { found: true, distance, withinTolerance };
        const fraction = !withinTolerance ? 0 : b.tolerance === 0 ? 1 : 1 - distance / (2 * b.tolerance);
        component(w.placement, fraction);
        notes.push(`placement: ${distance} cell${distance === 1 ? "" : "s"} off (tolerance ${b.tolerance})`);
      }
    }

    const controls = expected.mustNotChangeStyleIds ?? [];
    if (controls.length) {
      if (!finalDraft) {
        component(w.control, 0);
        notes.push("control: no draft");
      } else if (!outcome.impact) {
        notes.push("control: not checked (no impact data)");
      } else {
        const byId = new Map(outcome.impact.map((r) => [r.styleId, r.changed]));
        const changed = controls.filter((id) => byId.get(id) === true);
        const unknown = controls.filter((id) => !byId.has(id));
        controlUnchanged = changed.length === 0 && unknown.length === 0;
        component(w.control, controlUnchanged ? 1 : 0);
        if (changed.length) notes.push(`control changed: ${changed.join(", ")}`);
        else if (unknown.length) notes.push(`control not rendered: ${unknown.join(", ")}`);
        else notes.push("control styles unchanged");
      }
    }

    if (finalDraft && outcome.impact) {
      const meant = benchCase.styles.filter((s) => s.group === "changed").map((s) => s.id);
      const still = meant.filter((id) => outcome.impact!.some((r) => r.styleId === id && !r.changed));
      if (still.length) notes.push(`the draft does not change ${still.join(", ")} (the request's style)`);
    }
  } else if (expected.verdict === "gap") {
    const w = SCORE_WEIGHTS.gap;
    component(w.verdict, verdictOk ? 1 : 0);
    const declared =
      outcome.terminal?.name === "declare_gap" ? String((outcome.terminal.input as { tokenKey?: unknown })?.tokenKey ?? "") : "";
    tokensOk = declared !== "" && gapKeyMatches(declared, expected.gapTokenKey ?? "");
    component(w.gapKey, tokensOk ? 1 : 0);
    notes.push(
      declared
        ? `gap token {{${declared}}}${tokensOk ? "" : ` does not match {{${expected.gapTokenKey}}}`}`
        : "no gap declared",
    );
  } else {
    component(SCORE_WEIGHTS.question.verdict, verdictOk ? 1 : 0);
  }

  const penalty = Math.min(MAX_WARNING_PENALTY, warnings * WARNING_PENALTY);
  if (warnings) notes.push(`${warnings} warning${warnings === 1 ? "" : "s"} on the handed-over draft (−${penalty})`);
  const base = possible > 0 ? (100 * earned) / possible : 0;
  const total = Math.max(0, Math.min(100, Math.round(base - penalty)));

  return {
    verdict,
    verdictOk,
    tokensOk,
    ...(placement ? { placement } : {}),
    ...(controlUnchanged !== undefined ? { controlUnchanged } : {}),
    warnings,
    total,
    notes,
  };
}
