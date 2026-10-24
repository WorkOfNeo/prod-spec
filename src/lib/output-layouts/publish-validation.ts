import { CONTROL_RE, IF_RE, LayoutDefSchema, tokensInDef, type LayoutDef } from "./schema";
import { validateLineConditionals, validateTokenRef } from "./token-meta";
import { validateLineCalcs } from "./calc";

// =====================================================
// The strict gate a layout definition must pass before it may print.
// Unknown variables and malformed args are publish blockers here, not just
// preview warnings; so are malformed {{if}}/{{else}}/{{endif}} and calculated
// fields ({{= …}}) with bad syntax or an unknown/unusable field, and a layout
// with no blocks at all.
//
// One gate, two callers: POST /api/admin/output-layouts/[id]/publish (the
// Output Builder's Publish button) and publishRevision() in revisions.ts (a
// reviewed draft). Keeping it here means a draft can never reach print through
// a looser check than the builder's own button.
//
// PURE — validates the raw stored JSON and returns the schema-parsed def;
// never touches the DB.
// =====================================================

export type PublishValidation =
  | { ok: true; def: LayoutDef }
  | { ok: false; error: string; details: string[] };

export function validateLayoutForPublish(def: unknown): PublishValidation {
  const defParse = LayoutDefSchema.safeParse(def);
  if (!defParse.success) {
    return {
      ok: false,
      error: "Layout definition is invalid",
      details: defParse.error.issues.map((i) => i.message),
    };
  }
  const parsed = defParse.data;

  const problems: string[] = [];
  for (const ref of tokensInDef(parsed)) {
    problems.push(...validateTokenRef(ref.key, ref.arg, ref.arg2));
  }
  for (const page of parsed.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        problems.push(...validateLineConditionals(line, IF_RE, CONTROL_RE));
        problems.push(...validateLineCalcs(line));
      }
    }
  }
  const blockCount = parsed.pages.reduce((n, p) => n + p.blocks.length, 0);
  if (blockCount === 0) problems.push("layout has no blocks — nothing would print");

  if (problems.length > 0) {
    return { ok: false, error: "Layout can't be published", details: problems };
  }
  return { ok: true, def: parsed };
}
