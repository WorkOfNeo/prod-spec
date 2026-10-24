import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { mapWithConcurrency } from "@/lib/checks/style-pool";
import { getCurrentOutputsForStyles, type CurrentOutput } from "@/lib/outputs/current-outputs";
import { renderStyleOutput, type RenderedOutputDoc } from "@/lib/output-layouts/render-output";
import { getRevision, RevisionNotFoundError } from "@/lib/output-layouts/revisions";
import { parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import { stylesUsingLayout } from "@/lib/output-layouts/usage";
import { layoutVariantKey } from "@/lib/output-layouts/variant-keys";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { isMissingTable } from "./db-safe";
import {
  IMPACT_REVIEW_STATUSES,
  type ImpactCounts,
  type ImpactReviewStatus,
  type ImpactRow,
  type ImpactSummary,
} from "./types";

// =====================================================
// Impact list — exactly which documents a proposed layout definition would
// change (design docs/plans/change-requests.md §5.4). SERVER-ONLY (imports db).
//
// "Would change" is decided by RENDERING, not by reading the diff: a changed
// line may sit behind a conditional no style takes, or a token may resolve to
// the same text either way, and only the render knows. So for every style that
// prints the layout (usage.ts: an enabled output on its ProdSpec, style not
// archived/deleted) both definitions go through renderStyleOutput — the
// faithful per-output render the runner's output matches — and the documents
// are compared one by one.
//
// Both sides take the SAME path on purpose: the live definition is passed in
// as `definition` too, rather than rendered from the registry, so the only
// thing that can differ between the two HTML strings is the definition itself
// (the registry may lag a builder autosave by its TTL; a definition can't).
// The style's render context is loaded once and shared by both renders.
//
// Each document is then joined with what it means to rerun it: the review
// status of the style's CURRENT asset for that document (an approved one needs
// a second confirmation before it is rerun), whether the base output was
// already uploaded / emailed to the supplier, and whether a job is in flight
// for the style (never rerun underneath it). publish.ts reruns from these rows;
// the review screen shows them.
//
// Read-only: nothing here writes, except impactForRevision caching the summary
// on its change-request output. The pure core (normaliseHtml, compareDocs,
// mapReviewStatus, buildImpactRows, summarise) is exported and tested without
// a database; computeImpact only orchestrates.
// =====================================================

// Styles compared at most per call. A layout on more styles than this is
// refused rather than left to run into the route's maxDuration.
export const IMPACT_STYLE_LIMIT = 400;

// Styles rendered at once. Each style is a context load plus two renders, all
// latency-bound reads; four keeps several round trips in the air without
// crowding the shared pool (see checks/style-pool.ts).
export const IMPACT_CONCURRENCY = 4;

export class ImpactTooLargeError extends Error {
  readonly httpStatus = 422;
  constructor(readonly limit: number) {
    super(`This layout prints on more than ${limit} styles, too many to compare in one go.`);
    this.name = "ImpactTooLargeError";
  }
}

// ── Pure core ────────────────────────────────────────────────────────────────

// Both sides come out of one renderer through one path, so an exact comparison
// is nearly right already. The one thing normalised away is FORMATTING
// whitespace: any whitespace run that spans a line break (template
// indentation, the blank line a skipped conditional leaves) becomes a single
// newline, line endings are unified and the ends trimmed.
//
// Runs of spaces WITHOUT a line break are deliberately kept. Line text renders
// inside `.ol-line`, which is `white-space: pre-wrap`, so "A  B" → "A B" is a
// change on paper and must count as one; collapsing every run would hide
// exactly the spacing fixes a change request asks for. Nothing else is
// touched: block ids never reach the HTML, and data: URIs, barcodes and
// attribute order are deterministic for a given definition and style.
// (ASCII whitespace only: `\s` would also eat a literal no-break space, which
// prints.)
export function normaliseHtml(html: string): string {
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]*\n[ \t\n\f\v]*/g, "\n")
    .replace(/^[ \t\n\f\v]+|[ \t\n\f\v]+$/g, "");
}

export type ComparableDoc = Pick<RenderedOutputDoc, "suffix" | "html">;
export type DocComparison = { suffix: string | null; changed: boolean };

// Pair documents by suffix (null = the output's single document) and compare
// their normalised HTML. A document present on only one side — the proposal
// splits differently, a size gains or loses its own PDF — counts as changed:
// rerunning would add or drop that file. Order: the current side's documents,
// then the ones only the proposal has. A repeated suffix keeps its first copy
// (the runner keys assets by suffix, so a second one could never print).
export function compareDocs(
  current: readonly ComparableDoc[],
  proposed: readonly ComparableDoc[],
): DocComparison[] {
  const index = (docs: readonly ComparableDoc[]) => {
    const byKey = new Map<string | null, string>();
    for (const d of docs) if (!byKey.has(d.suffix)) byKey.set(d.suffix, normaliseHtml(d.html));
    return byKey;
  };
  const before = index(current);
  const after = index(proposed);
  const out: DocComparison[] = [];
  for (const [suffix, html] of before) {
    out.push({ suffix, changed: !after.has(suffix) || after.get(suffix) !== html });
  }
  for (const suffix of after.keys()) {
    if (!before.has(suffix)) out.push({ suffix, changed: true });
  }
  return out;
}

// The key a document's asset is stored under: the base for a single-document
// output, "<base>#<suffix>" for one PDF of a split output (runner-same).
export function docKey(baseKey: string, suffix: string | null): string {
  return suffix === null ? baseKey : `${baseKey}#${suffix}`;
}

// The current asset's review status, or NONE when nothing was generated.
export function mapReviewStatus(status: CurrentOutput["reviewStatus"] | undefined): ImpactReviewStatus {
  switch (status) {
    case "PENDING_REVIEW":
    case "APPROVED":
    case "REJECTED":
      return status;
    default:
      return "NONE";
  }
}

// One style's compared documents, before the join.
export type StyleComparison = {
  styleId: string;
  styleLabel: string;
  poNumber: string | null;
  // The output's base key (layout:<id>).
  baseKey: string;
  docs: DocComparison[];
};

export type ImpactJoin = {
  // styleId → doc key → review status of the current asset there.
  reviewByStyle: ReadonlyMap<string, ReadonlyMap<string, ImpactReviewStatus>>;
  // styleId → delivery state of the base output (SupplierSendQueueItem).
  deliveryByStyle: ReadonlyMap<string, { uploaded: boolean; emailed: boolean }>;
  // Styles with a QUEUED or RUNNING job.
  inFlight: ReadonlySet<string>;
};

export function buildImpactRows(comparisons: readonly StyleComparison[], join: ImpactJoin): ImpactRow[] {
  const rows: ImpactRow[] = [];
  for (const c of comparisons) {
    const review = join.reviewByStyle.get(c.styleId);
    const delivery = join.deliveryByStyle.get(c.styleId);
    const inFlight = join.inFlight.has(c.styleId);
    for (const d of c.docs) {
      const key = docKey(c.baseKey, d.suffix);
      rows.push({
        styleId: c.styleId,
        styleLabel: c.styleLabel,
        poNumber: c.poNumber,
        variantKey: key,
        changed: d.changed,
        reviewStatus: review?.get(key) ?? "NONE",
        uploaded: delivery?.uploaded ?? false,
        emailed: delivery?.emailed ?? false,
        inFlight,
      });
    }
  }
  return rows;
}

// Counts for the summary. `styles` defaults to the styles that have rows; the
// loader passes the number it compared (a style may render no documents).
export function summarise(rows: readonly ImpactRow[], styles?: number): ImpactCounts {
  const changedByStatus = Object.fromEntries(IMPACT_REVIEW_STATUSES.map((s) => [s, 0])) as Record<
    ImpactReviewStatus,
    number
  >;
  let changed = 0;
  let approvedChanged = 0;
  let deliveredChanged = 0;
  for (const r of rows) {
    if (!r.changed) continue;
    changed++;
    changedByStatus[r.reviewStatus]++;
    if (r.reviewStatus === "APPROVED") approvedChanged++;
    if (r.uploaded || r.emailed) deliveredChanged++;
  }
  return {
    styles: styles ?? new Set(rows.map((r) => r.styleId)).size,
    docs: rows.length,
    changed,
    unchanged: rows.length - changed,
    changedByStatus,
    approvedChanged,
    deliveredChanged,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export type ComputeImpactInput = {
  layoutId: string;
  proposedDef: LayoutDef;
  // The "before" side. Defaults to the layout's live definition; a caller
  // re-checking after a publish passes what was live before it.
  currentDef?: LayoutDef;
  limit?: number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The join, read in three batch queries for every compared style at once.
async function loadJoin(styleIds: string[], baseKey: string): Promise<ImpactJoin> {
  if (styleIds.length === 0) return { reviewByStyle: new Map(), deliveryByStyle: new Map(), inFlight: new Set() };
  const [outputsByStyle, deliveries, inflight] = await Promise.all([
    getCurrentOutputsForStyles(styleIds),
    db.supplierSendQueueItem.findMany({
      where: { styleId: { in: styleIds }, variantKey: baseKey },
      select: { styleId: true, sharePointStatus: true, sentAt: true },
    }),
    db.job.findMany({
      where: { styleId: { in: styleIds }, status: { in: ["QUEUED", "RUNNING"] } },
      select: { styleId: true },
    }),
  ]);
  const reviewByStyle = new Map<string, Map<string, ImpactReviewStatus>>();
  for (const [styleId, outputs] of outputsByStyle) {
    reviewByStyle.set(styleId, new Map(outputs.map((o) => [o.variantKey, mapReviewStatus(o.reviewStatus)])));
  }
  const deliveryByStyle = new Map(
    deliveries.map((d) => [d.styleId, { uploaded: d.sharePointStatus === "UPLOADED", emailed: d.sentAt != null }]),
  );
  return { reviewByStyle, deliveryByStyle, inFlight: new Set(inflight.map((j) => j.styleId)) };
}

export async function computeImpact(input: ComputeImpactInput): Promise<ImpactSummary> {
  const started = Date.now();
  const { layoutId, proposedDef } = input;
  const limit = input.limit ?? IMPACT_STYLE_LIMIT;

  const layout = await db.outputLayout.findUnique({ where: { id: layoutId }, select: { definition: true } });
  if (!layout) throw new RevisionNotFoundError("layout", layoutId);
  const currentDef = input.currentDef ?? parseLayoutDef(layout.definition);

  // One more than the limit, so "exactly at the limit" and "over it" differ.
  const usages = await stylesUsingLayout(layoutId, { limit: limit + 1 });
  if (usages.length > limit) throw new ImpactTooLargeError(limit);

  const baseKey = layoutVariantKey(layoutId);
  const errors: { styleId: string; message: string }[] = [];
  const compared = await mapWithConcurrency(usages, IMPACT_CONCURRENCY, async (u) => {
    try {
      const ctx = await loadStyleRenderContext(u.styleId);
      if (!ctx) throw new Error("Style not found");
      const render = (definition: LayoutDef) =>
        renderStyleOutput({
          ctx,
          variantKey: u.output.variantKey,
          definition,
          mode: "production",
          documents: "files",
          withUnresolved: false,
        });
      // One after the other: the pool's width is the budget for reads in
      // flight, and doubling it per style would defeat that.
      const current = await render(currentDef);
      const proposed = await render(proposedDef);
      return {
        styleId: u.styleId,
        styleLabel: u.label,
        poNumber: u.poNumber,
        baseKey,
        docs: compareDocs(current.docs, proposed.docs),
      } satisfies StyleComparison;
    } catch (err) {
      errors.push({ styleId: u.styleId, message: errorMessage(err) });
      return null;
    }
  });
  const comparisons = compared.filter((c): c is StyleComparison => c !== null);

  const join = await loadJoin(comparisons.map((c) => c.styleId), baseKey);
  const rows = buildImpactRows(comparisons, join);
  const counts = summarise(rows, comparisons.length);
  // Errors in input order, whatever order the pool finished them in.
  const order = new Map(usages.map((u, i) => [u.styleId, i]));
  errors.sort((a, b) => (order.get(a.styleId) ?? 0) - (order.get(b.styleId) ?? 0));
  const durationMs = Date.now() - started;

  // Counts and timing only — no style names, POs or HTML in the log.
  console.info(
    `[change-requests] impact layout=${layoutId}` +
      ` | styles=${counts.styles} docs=${counts.docs} changed=${counts.changed}` +
      ` | approvedChanged=${counts.approvedChanged} deliveredChanged=${counts.deliveredChanged}` +
      ` | errors=${errors.length} | ${durationMs}ms`,
  );

  return { rows, counts, errors, durationMs };
}

// The impact of a revision's definition against what is live now. When the
// revision is still its change-request output's current draft, the summary is
// cached on the output (ChangeRequestOutput.impact) for the review screen; the
// conditional update means a newer draft that landed meanwhile is never
// overwritten with a stale list. Throws RevisionNotFoundError (404) and
// ImpactTooLargeError (422).
export async function impactForRevision(revisionId: string): Promise<ImpactSummary> {
  const revision = await getRevision(revisionId);
  if (!revision) throw new RevisionNotFoundError("revision", revisionId);

  const summary = await computeImpact({
    layoutId: revision.layoutId,
    proposedDef: parseLayoutDef(revision.definition),
  });

  if (revision.changeRequestOutputId) {
    try {
      await db.changeRequestOutput.updateMany({
        where: { id: revision.changeRequestOutputId, currentRevisionId: revision.id },
        data: { impact: summary as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      // Only the not-yet-deployed table is forgiven (db-safe.ts); the list
      // itself is still returned.
      if (!isMissingTable(err)) throw err;
    }
  }
  return summary;
}
