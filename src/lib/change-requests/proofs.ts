import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { mapWithConcurrency } from "@/lib/checks/style-pool";
import { renderHtmlPng } from "@/lib/pdf/renderer";
import type { StyleData } from "@/lib/pdf/types";
import { describeLayoutChanges } from "@/lib/output-layouts/ops";
import {
  RenderOutputError,
  renderStyleOutput,
  resolveOutputTarget,
  splitVariantKey,
  type RenderedOutputDoc,
} from "@/lib/output-layouts/render-output";
import { getRevision } from "@/lib/output-layouts/revisions";
import {
  conditionMatches,
  conditionalsInLine,
  parseLayoutDef,
  type LayoutDef,
  type LineConditional,
} from "@/lib/output-layouts/schema";
import {
  augmentCompositionTranslations,
  augmentTranslatedFields,
  compositionLangsInDef,
  langArgsInDef,
  resolveTextToken,
} from "@/lib/output-layouts/tokens";
import { stylesUsingLayout } from "@/lib/output-layouts/usage";
import { layoutVariantKey } from "@/lib/output-layouts/variant-keys";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import type { ImpactReviewStatus, ImpactRow, ImpactSummary, RevisionStatus } from "./types";

// =====================================================
// Before/after proofs for a layout draft (design docs/plans/change-requests.md
// §5.5). SERVER-ONLY: the loaders and renderProof import db; the picker and
// its helpers are pure and tested without one.
//
// Two questions, two halves:
//
//   1. WHICH documents to show (pickRepresentatives, pure). The impact list
//      says exactly which documents change, but a reviewer can't look at 300
//      pictures. A handful chosen on purpose proves more than a random few:
//        • "changed"  one per distinct kind of changed document (a split
//                     output's per-size files and its assortment file are
//                     different kinds), spread over review statuses, the
//                     request's own style first;
//        • "branch"   for every {{if …}} in the lines the draft touches, a
//                     style that takes the branch and one that doesn't — the
//                     classic miss is a new conditional block that is right
//                     where the value is set and wrong (or not hidden) where
//                     it is empty;
//        • "control"  one document that must NOT change, shown as "no change,
//                     expected", so a draft that silently moves everything is
//                     visible on the review screen and not only in a count.
//
//   2. WHAT they look like (renderProof). "before" is the layout as it prints
//      today, "after" the draft, both through renderStyleOutput — the same
//      faithful per-output render the runner and impact use (pins, carton
//      preference, info-area size, reviewer line rewrites) — then one document
//      is rasterised by renderHtmlPng. Nothing is written anywhere: a proof is
//      a picture of a draft, never a change to what prints.
//
// There is deliberately no list route: the review screen combines the stored
// impact with pickProofsForRevision() server-side, then loads each picture
// from GET /api/admin/change-requests/revisions/[revisionId]/proof.
// =====================================================

// ── Errors ───────────────────────────────────────────────────────────────────
// Each carries the HTTP status the proof route answers with.

// Unknown revision (or its layout), a style that doesn't print the layout, a
// document index / suffix the output doesn't emit.
export class ProofNotFoundError extends Error {
  readonly httpStatus = 404;
  constructor(
    readonly what: "revision" | "layout" | "style" | "doc",
    message: string,
  ) {
    super(message);
    this.name = "ProofNotFoundError";
  }
}

// The output exists but has no picture to give: a stored definition that no
// longer parses, a static-artwork output.
export class ProofRenderError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) {
    super(message);
    this.name = "ProofRenderError";
  }
}

// ── Picks (pure) ─────────────────────────────────────────────────────────────

export type ProofReason = "changed" | "branch" | "control";

export type ProofPick = {
  styleId: string;
  styleLabel: string;
  // The impact row's key, verbatim, so the review screen can join a pick back
  // to its row ("layout:<id>" or "layout:<id>#<suffix>").
  variantKey: string;
  // The document of a split output (the proof route's `suffix`); null for an
  // output that emits one document.
  suffix: string | null;
  reason: ProofReason;
  // Plain words for the reviewer: why this one is shown and what to expect.
  note: string;
};

// styleId → conditional field → the value the renderer sees ("" when empty).
export type ProofFieldValues = Record<string, Record<string, string>>;

export type PickRepresentativesInput = {
  impact: Pick<ImpactSummary, "rows">;
  // The layout as it prints today and the draft.
  before: LayoutDef;
  after: LayoutDef;
  // From loadFieldValues(); without it there are no "branch" picks.
  fieldValues?: ProofFieldValues;
  max?: number;
  // The request's own style (ChangeRequestOutput.styleId): its changed
  // document leads the list.
  focusStyleId?: string | null;
  // styleId → prodSpecId, so the control comes from the same ProdSpec as the
  // first changed document. Impact rows don't carry the ProdSpec; without
  // this map the same PO stands in.
  prodSpecIds?: Readonly<Record<string, string>>;
};

export const DEFAULT_MAX_PICKS = 6;

// "Most useful first" among changed documents. Pending review is what an
// approval reruns — the bulk of any change; an approved document needs the
// admin's second confirmation, so seeing one changed is the next most useful;
// "NONE" (never generated) has nothing printed to compare with yet.
const STATUS_RANK: Record<ImpactReviewStatus, number> = {
  PENDING_REVIEW: 0,
  APPROVED: 1,
  REJECTED: 2,
  NONE: 3,
};

const STATUS_TEXT: Record<ImpactReviewStatus, string> = {
  PENDING_REVIEW: "pending review",
  APPROVED: "approved",
  REJECTED: "rejected",
  NONE: "never generated",
};

const REASON_ORDER: Record<ProofReason, number> = { changed: 0, branch: 1, control: 2 };

// What KIND of document a split output's suffix names. Suffixes carry the
// style's own sizes and colours ("M-Black", "S-Red-2"), so they never repeat
// across styles; what does repeat is the shape: one document, one per size /
// EAN row, or the assortment carton (always "assort…", see splitFilePlan in
// output-layouts/variants.ts).
export function suffixPattern(suffix: string | null): "single" | "assort" | "per-row" {
  if (suffix === null || suffix === "") return "single";
  return /^assort/i.test(suffix) ? "assort" : "per-row";
}

// Two changed documents with the same signature are the same kind of
// document on different styles; one proof stands for all of them.
export function docSignature(variantKey: string): string {
  const { baseKey, suffix } = splitVariantKey(variantKey);
  return `${baseKey}|${suffixPattern(suffix)}`;
}

type Candidate = { row: ImpactRow; index: number; suffix: string | null; key: string };

function pickKey(styleId: string, suffix: string | null): string {
  return `${styleId}\u0000${suffix ?? ""}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Lexicographic compare of score tuples (lower wins).
function byScore<T>(score: (x: T) => number[]): (a: T, b: T) => number {
  return (a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const d = (sa[i] ?? 0) - (sb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
}

function changedNote(row: ImpactRow, focus: boolean): string {
  const parts = [STATUS_TEXT[row.reviewStatus]];
  if (row.emailed) parts.push("already emailed to the supplier");
  else if (row.uploaded) parts.push("already uploaded for the supplier");
  if (row.inFlight) parts.push("a run is in progress");
  return `${focus ? "the request's style · " : ""}changes · ${parts.join(", ")}`;
}

// What the conditional does for one value: the branch body it prints, said
// plainly. A conditional with one empty side "shows" or is "hidden"; one with
// two printing sides names the side it prints.
function branchEffect(cond: LineConditional, matched: boolean): string {
  const body = (matched ? cond.ifBody : cond.elseBody).trim();
  const other = (matched ? cond.elseBody : cond.ifBody).trim();
  if (body === "") return "hidden";
  if (other === "") return "shows";
  return `prints ${clip(body, 40)}`;
}

function branchNote(cond: LineConditional, value: string, matched: boolean, changed: boolean): string {
  const shown = value.trim() === "" ? `${cond.field} empty` : `${cond.field} = ${JSON.stringify(clip(value.trim(), 40))}`;
  return `${shown} → ${branchEffect(cond, matched)}${changed ? "" : " (no change)"}`;
}

function normaliseDef(def: LayoutDef): LayoutDef {
  try {
    return parseLayoutDef(structuredClone(def));
  } catch {
    return def;
  }
}

// The conditionals a reviewer must see both ways: every {{if …}} in a line
// the draft adds, removes or rewrites, and every {{if …}} in a block the
// draft moves, resizes or restyles (the whole block prints differently, but
// only where its conditional shows). Whole pages added or removed count with
// all their lines. Built on describeLayoutChanges so "what changed" means the
// same here as on the review screen's definition diff. Deduped, in order.
export function changedConditionals(before: LayoutDef, after: LayoutDef): LineConditional[] {
  const a = normaliseDef(before);
  const b = normaliseDef(after);
  const lines: string[] = [];
  const seenLine = new Set<string>();
  const addLine = (line: string) => {
    if (seenLine.has(line)) return;
    seenLine.add(line);
    lines.push(line);
  };

  const pagesA = new Map(a.pages.map((p) => [p.id, p]));
  const pageIdsB = new Set(b.pages.map((p) => p.id));
  for (const page of b.pages) {
    if (!pagesA.has(page.id)) for (const blk of page.blocks) blk.lines.forEach(addLine);
  }
  for (const page of a.pages) {
    if (!pageIdsB.has(page.id)) for (const blk of page.blocks) blk.lines.forEach(addLine);
  }

  for (const change of describeLayoutChanges(a, b)) {
    if (!change.blockId) continue;
    // Block changes are reported against the page's index in `after`.
    const pageB = b.pages[change.page];
    const pageA = pageB ? pagesA.get(pageB.id) : undefined;
    const blkB = pageB?.blocks.find((x) => x.id === change.blockId);
    const blkA = pageA?.blocks.find((x) => x.id === change.blockId);
    if (change.kind === "text" && blkA && blkB) {
      const linesA = new Set(blkA.lines);
      const linesB = new Set(blkB.lines);
      blkB.lines.filter((l) => !linesA.has(l)).forEach(addLine);
      blkA.lines.filter((l) => !linesB.has(l)).forEach(addLine);
    } else {
      (blkB ?? blkA)?.lines.forEach(addLine);
    }
  }

  const out: LineConditional[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const cond of conditionalsInLine(line)) {
      const key = [cond.field, cond.op, cond.value, cond.ifBody, cond.elseBody].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cond);
    }
  }
  return out;
}

// The fields loadFieldValues() must resolve for the branch picks.
export function branchFields(before: LayoutDef, after: LayoutDef): string[] {
  return [...new Set(changedConditionals(before, after).map((c) => c.field))];
}

export function pickRepresentatives(input: PickRepresentativesInput): ProofPick[] {
  const max = Math.max(0, Math.floor(input.max ?? DEFAULT_MAX_PICKS));
  if (max === 0) return [];
  const focusId = input.focusStyleId ?? null;
  const candidates: Candidate[] = input.impact.rows.map((row, index) => {
    const { suffix } = splitVariantKey(row.variantKey);
    return { row, index, suffix, key: pickKey(row.styleId, suffix) };
  });

  const picks: ProofPick[] = [];
  const byKey = new Map<string, ProofPick>();
  // Adds a pick, or folds it into the pick already showing that document
  // (both notes kept), so one picture can answer two questions without
  // spending a second slot. The reason stays, except that a changed document
  // first picked for a branch is labelled changed: the control keeps its
  // "control" label whatever else it proves, or the screen would lose it.
  const add = (c: Candidate, reason: ProofReason, note: string) => {
    const existing = byKey.get(c.key);
    if (existing) {
      if (!existing.note.split("; ").includes(note)) existing.note = `${existing.note}; ${note}`;
      if (existing.reason === "branch" && reason === "changed") existing.reason = "changed";
      return;
    }
    if (picks.length >= max) return;
    const pick: ProofPick = {
      styleId: c.row.styleId,
      styleLabel: c.row.styleLabel,
      variantKey: c.row.variantKey,
      suffix: c.suffix,
      reason,
      note,
    };
    picks.push(pick);
    byKey.set(c.key, pick);
  };

  // ── changed: one per document signature ──
  const changed = candidates.filter((c) => c.row.changed);
  const baseScore = (c: Candidate) => [
    c.row.styleId === focusId ? 0 : 1,
    c.row.inFlight ? 1 : 0,
    STATUS_RANK[c.row.reviewStatus],
    c.index,
  ];
  const groups = new Map<string, Candidate[]>();
  for (const c of changed) {
    const sig = docSignature(c.row.variantKey);
    groups.set(sig, [...(groups.get(sig) ?? []), c]);
  }
  const orderedGroups = [...groups.values()]
    .map((g) => [...g].sort(byScore(baseScore)))
    .sort(byScore((g) => baseScore(g[0])));
  // Within each kind, prefer a review status no earlier kind has shown yet.
  const usedStatuses = new Set<ImpactReviewStatus>();
  const primaries: Candidate[] = [];
  for (const group of orderedGroups) {
    const best = [...group].sort(
      byScore((c) => [
        c.row.styleId === focusId ? 0 : 1,
        usedStatuses.has(c.row.reviewStatus) ? 1 : 0,
        ...baseScore(c).slice(1),
      ]),
    )[0];
    primaries.push(best);
    usedStatuses.add(best.row.reviewStatus);
  }
  // Then one more changed document per status still unseen ("prefer variety
  // of review statuses"), when slots remain.
  const extras: Candidate[] = [];
  for (const status of Object.keys(STATUS_RANK) as ImpactReviewStatus[]) {
    if (usedStatuses.has(status)) continue;
    const best = changed.filter((c) => c.row.reviewStatus === status).sort(byScore(baseScore))[0];
    if (best) {
      extras.push(best);
      usedStatuses.add(status);
    }
  }

  // ── control: one document that does not change ──
  const lead = primaries[0]?.row ?? null;
  const sameSpec = (row: ImpactRow) => {
    if (!lead) return false;
    const specs = input.prodSpecIds;
    if (specs && specs[lead.styleId] !== undefined) return specs[row.styleId] === specs[lead.styleId];
    return lead.poNumber !== null && row.poNumber === lead.poNumber;
  };
  const control = candidates
    .filter((c) => !c.row.changed)
    .sort(
      byScore((c) => [
        lead && c.row.styleId === lead.styleId ? 0 : 1,
        sameSpec(c.row) ? 0 : 1,
        c.row.inFlight ? 1 : 0,
        c.index,
      ]),
    )[0];

  // ── branch: both sides of every conditional the draft touches ──
  const branchPicks: { c: Candidate; note: string }[] = [];
  const planBranches = (taken: ReadonlySet<string>) => {
    const values = input.fieldValues;
    if (!values) return;
    const perField = new Map<string, LineConditional>();
    for (const cond of changedConditionals(input.before, input.after)) {
      if (!perField.has(cond.field)) perField.set(cond.field, cond);
    }
    for (const cond of perField.values()) {
      const withValue = candidates.filter((c) => values[c.row.styleId] !== undefined);
      for (const matched of [true, false]) {
        const side = withValue.filter(
          (c) => conditionMatches(values[c.row.styleId][cond.field] ?? "", cond.op, cond.value) === matched,
        );
        // A changed document first; among equals, one already on the list
        // (its picture then answers this too, without another slot).
        const best = side.sort(
          byScore((c) => [
            c.row.changed ? 0 : 1,
            taken.has(c.key) ? 0 : 1,
            c.row.styleId === focusId ? 0 : 1,
            c.row.inFlight ? 1 : 0,
            STATUS_RANK[c.row.reviewStatus],
            c.index,
          ]),
        )[0];
        if (!best) continue;
        const value = values[best.row.styleId][cond.field] ?? "";
        branchPicks.push({ c: best, note: branchNote(cond, value, matched, best.row.changed) });
      }
    }
  };

  // Slots are claimed in order of importance so the cap drops the least
  // useful first: the lead changed document, the control, the branches, the
  // other kinds of changed document, then the status-variety extras.
  if (primaries[0]) add(primaries[0], "changed", changedNote(primaries[0].row, primaries[0].row.styleId === focusId));
  if (control) add(control, "control", "no change, expected");
  planBranches(new Set(byKey.keys()));
  for (const { c, note } of branchPicks) add(c, "branch", note);
  for (const c of [...primaries.slice(1), ...extras]) add(c, "changed", changedNote(c.row, c.row.styleId === focusId));

  // Shown changed → branch → control, each in the order claimed.
  return picks
    .map((p, i) => ({ p, i }))
    .sort((x, y) => REASON_ORDER[x.p.reason] - REASON_ORDER[y.p.reason] || x.i - y.i)
    .map(({ p }) => p);
}

// ── Field values (DB) ────────────────────────────────────────────────────────

const FIELD_VALUE_CONCURRENCY = 4;

// The same translation-bank augmentation renderLayoutHtml runs before it
// renders (prepareLayoutRender), so a value read here is the value the
// conditional is evaluated against.
async function augmentLikeRenderer(style: StyleData, def: LayoutDef): Promise<StyleData> {
  let out = style;
  const compLangs = compositionLangsInDef(def);
  if (compLangs.length > 0) out = await augmentCompositionTranslations(out, compLangs);
  return augmentTranslatedFields(out, {
    care: langArgsInDef(def, "careInstructions"),
    madeIn: langArgsInDef(def, "madeIn"),
    madeInLabel: langArgsInDef(def, "madeInLabel"),
    country: langArgsInDef(def, "country"),
    countryOfOriginLabel: langArgsInDef(def, "countryOfOriginLabel"),
    manufacturer: langArgsInDef(def, "manufacturer"),
  });
}

// With the layout given, the style's data as THAT output renders it — admin
// pins and per-style field values applied — because a pinned value is what
// the conditional sees on paper. Falls back to the bare render context when
// the output can't be resolved (not configured, layout never published).
async function styleDataFor(
  styleId: string,
  opts: { layoutId?: string; definition?: LayoutDef },
): Promise<StyleData | null> {
  if (opts.layoutId) {
    try {
      const target = await resolveOutputTarget({
        styleId,
        variantKey: layoutVariantKey(opts.layoutId),
        definition: opts.definition,
        mode: "production",
      });
      return target.styleData;
    } catch (err) {
      if (!(err instanceof RenderOutputError)) throw err;
      if (err.code === "STYLE_NOT_FOUND") return null;
    }
  }
  const ctx = await loadStyleRenderContext(styleId);
  return ctx?.styleData ?? null;
}

// styleId → field → resolved text value, for the branch picks. A style that
// can't be read is left out (it simply isn't a branch candidate) rather than
// failing the whole pick.
export async function loadFieldValues(
  styleIds: readonly string[],
  fields: readonly string[],
  opts: { layoutId?: string; definition?: LayoutDef } = {},
): Promise<ProofFieldValues> {
  const ids = [...new Set(styleIds)];
  const keys = [...new Set(fields)];
  const out: ProofFieldValues = {};
  if (ids.length === 0 || keys.length === 0) return out;
  await mapWithConcurrency(ids, FIELD_VALUE_CONCURRENCY, async (styleId) => {
    try {
      const base = await styleDataFor(styleId, opts);
      if (!base) return;
      const style = opts.definition ? await augmentLikeRenderer(base, opts.definition) : base;
      out[styleId] = Object.fromEntries(keys.map((k) => [k, resolveTextToken(style, k)]));
    } catch (err) {
      console.warn(`[change-requests/proofs] field values for style ${styleId}: ${(err as Error).message}`);
    }
  });
  return out;
}

// ── Revision definitions (DB) ────────────────────────────────────────────────

type ProofDefinitions = {
  layoutId: string;
  layoutVersion: number;
  before: LayoutDef;
  after: LayoutDef;
  // Cache identity of `before`: a builder autosave changes the live
  // definition WITHOUT bumping version, so the live side is keyed by a hash
  // of the definition too.
  beforeKey: string;
};

function parseStoredDef(raw: unknown, what: string): LayoutDef {
  try {
    return parseLayoutDef(raw);
  } catch (err) {
    throw new ProofRenderError(`The ${what} definition can't be rendered: ${(err as Error).message}`);
  }
}

function hashJson(v: unknown): string {
  return createHash("sha1").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 16);
}

// before = what prints today (the live definition); after = the draft. Once
// a revision is PUBLISHED the live definition IS its definition, so "before"
// becomes what was live when it was drafted — the pair stays meaningful on
// the review screen and in the "now live" email after approval.
async function loadProofDefinitions(revisionId: string): Promise<ProofDefinitions> {
  const revision = await getRevision(revisionId);
  if (!revision) throw new ProofNotFoundError("revision", "Revision not found");
  const layout = await db.outputLayout.findUnique({
    where: { id: revision.layoutId },
    select: { definition: true, version: true },
  });
  if (!layout) throw new ProofNotFoundError("layout", "Layout not found");
  const published = revision.status === ("PUBLISHED" satisfies RevisionStatus);
  return {
    layoutId: revision.layoutId,
    layoutVersion: layout.version,
    before: parseStoredDef(published ? revision.baseDefinition : layout.definition, "current layout"),
    after: parseStoredDef(revision.definition, "draft"),
    beforeKey: published ? "base" : `live:${layout.version}:${hashJson(layout.definition)}`,
  };
}

// The server half of the review screen's proof strip: the picks for a
// revision, given the impact already computed for it. Field values are read
// for a bounded sample of styles (changed ones first) — enough to find both
// sides of a conditional without rebuilding every style's data again.
export async function pickProofsForRevision(input: {
  revisionId: string;
  impact: Pick<ImpactSummary, "rows">;
  focusStyleId?: string | null;
  max?: number;
  candidateStyles?: number;
}): Promise<ProofPick[]> {
  const defs = await loadProofDefinitions(input.revisionId);
  const fields = branchFields(defs.before, defs.after);
  const limit = Math.max(1, input.candidateStyles ?? 24);
  const ordered = [
    ...(input.focusStyleId ? [input.focusStyleId] : []),
    ...input.impact.rows.filter((r) => r.changed).map((r) => r.styleId),
    ...input.impact.rows.filter((r) => !r.changed).map((r) => r.styleId),
  ];
  const styleIds = [...new Set(ordered)].slice(0, limit);
  const [fieldValues, usage] = await Promise.all([
    fields.length > 0
      ? loadFieldValues(styleIds, fields, { layoutId: defs.layoutId, definition: defs.after })
      : Promise.resolve(undefined),
    stylesUsingLayout(defs.layoutId).catch(() => []),
  ]);
  return pickRepresentatives({
    impact: input.impact,
    before: defs.before,
    after: defs.after,
    fieldValues,
    max: input.max,
    focusStyleId: input.focusStyleId,
    prodSpecIds: Object.fromEntries(usage.map((u) => [u.styleId, u.prodSpecId])),
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

export const PROOF_SIDES = ["before", "after"] as const;
export type ProofSide = (typeof PROOF_SIDES)[number];

export type ProofImage = {
  png: Buffer;
  widthMm: number;
  heightMm: number;
  suffix: string | null;
  // Index of the document pictured among the output's documents.
  doc: number;
};

export type RenderProofInput = {
  revisionId: string;
  styleId: string;
  side: ProofSide;
  // Which document of a split output: by index (default 0) or, when given,
  // by suffix — a pick's suffix, which stays right even if the draft changes
  // how many documents the output emits.
  doc?: number;
  suffix?: string;
  scale?: number;
};

export const DEFAULT_PROOF_SCALE = 3;

// The render step: pick one rendered document and rasterise its first page.
// Exported so the picture can be tested against a real browser without a
// database.
export async function rasteriseProofDoc(
  docs: readonly RenderedOutputDoc[],
  opts: { doc?: number; suffix?: string; scale?: number } = {},
): Promise<ProofImage> {
  let index: number;
  if (opts.suffix !== undefined) {
    index = docs.findIndex((d) => (d.suffix ?? "") === opts.suffix);
    if (index < 0) throw new ProofNotFoundError("doc", `This output has no document "${opts.suffix}"`);
  } else {
    index = opts.doc ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= docs.length) {
      throw new ProofNotFoundError(
        "doc",
        `Document ${index} is out of range (this output has ${docs.length} document${docs.length === 1 ? "" : "s"})`,
      );
    }
  }
  const picked = docs[index];
  const png = await renderHtmlPng({
    html: picked.html,
    widthMm: picked.widthMm,
    heightMm: picked.heightMm,
    scale: opts.scale ?? DEFAULT_PROOF_SCALE,
  });
  return { png, widthMm: picked.widthMm, heightMm: picked.heightMm, suffix: picked.suffix, doc: index };
}

// Small in-process LRU of finished pictures, keyed by everything that changes
// the bytes. It holds the PROMISE, so the review screen asking for the same
// picture twice at once renders it once; a failure is evicted at once. Entries
// expire with the route's max-age, so a style edited meanwhile isn't served
// from here for longer than the browser would cache it anyway.
const PROOF_CACHE_MAX = 50;
const PROOF_CACHE_TTL_MS = 5 * 60 * 1000;
const proofCache = new Map<string, { at: number; value: Promise<ProofImage> }>();

function cachedProof(key: string, make: () => Promise<ProofImage>): Promise<ProofImage> {
  const now = Date.now();
  const hit = proofCache.get(key);
  if (hit && now - hit.at < PROOF_CACHE_TTL_MS) {
    proofCache.delete(key);
    proofCache.set(key, hit); // most recently used last
    return hit.value;
  }
  if (hit) proofCache.delete(key);
  const value = make();
  proofCache.set(key, { at: now, value });
  value.catch(() => {
    if (proofCache.get(key)?.value === value) proofCache.delete(key);
  });
  while (proofCache.size > PROOF_CACHE_MAX) {
    const oldest = proofCache.keys().next().value;
    if (oldest === undefined) break;
    proofCache.delete(oldest);
  }
  return value;
}

// Tests only.
export function clearProofCache(): void {
  proofCache.clear();
}

export async function renderProof(input: RenderProofInput): Promise<ProofImage> {
  const scale = input.scale ?? DEFAULT_PROOF_SCALE;
  const defs = await loadProofDefinitions(input.revisionId);
  const which = input.suffix !== undefined ? `s:${input.suffix}` : `d:${input.doc ?? 0}`;
  const defKey = input.side === "before" ? defs.beforeKey : `v${defs.layoutVersion}`;
  const key = [input.revisionId, input.styleId, input.side, which, defKey, scale].join("|");

  return cachedProof(key, async () => {
    let docs: RenderedOutputDoc[];
    try {
      ({ docs } = await renderStyleOutput({
        styleId: input.styleId,
        variantKey: layoutVariantKey(defs.layoutId),
        definition: input.side === "before" ? defs.before : defs.after,
        mode: "production",
        documents: "files",
        withUnresolved: false,
      }));
    } catch (err) {
      if (!(err instanceof RenderOutputError)) throw err;
      // Unknown style, or a style whose ProdSpec doesn't print this layout.
      if (err.status === 404) throw new ProofNotFoundError("style", err.message);
      throw new ProofRenderError(err.message);
    }
    return rasteriseProofDoc(docs, { doc: input.doc, suffix: input.suffix, scale });
  });
}

// ── Route query (pure) ───────────────────────────────────────────────────────
// Lives here, not in the route file: a Next route module may only export its
// handlers and segment config.

const MAX_DOC_INDEX = 999;
const MAX_PARAM_CHARS = 200;

export function parseProofQuery(
  params: URLSearchParams,
): { ok: true; value: Omit<RenderProofInput, "revisionId" | "scale"> } | { ok: false; error: string } {
  const styleId = params.get("styleId")?.trim() ?? "";
  if (!styleId || styleId.length > MAX_PARAM_CHARS) return { ok: false, error: "styleId is required" };
  const side = params.get("side");
  if (side !== "before" && side !== "after") return { ok: false, error: 'side must be "before" or "after"' };
  const docRaw = params.get("doc");
  let doc = 0;
  if (docRaw !== null && docRaw !== "") {
    if (!/^\d+$/.test(docRaw) || Number(docRaw) > MAX_DOC_INDEX) {
      return { ok: false, error: "doc must be a document index (0, 1, 2, …)" };
    }
    doc = Number(docRaw);
  }
  const suffixRaw = params.get("suffix");
  if (suffixRaw !== null && (suffixRaw === "" || suffixRaw.length > MAX_PARAM_CHARS)) {
    return { ok: false, error: "suffix must name a document" };
  }
  return { ok: true, value: { styleId, side, doc, ...(suffixRaw !== null ? { suffix: suffixRaw } : {}) } };
}
