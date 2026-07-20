import { db } from "@/lib/db";
import { repetitionStyles } from "./render";
import { layoutSettings, parseLayoutDef, type LayoutSettings } from "./schema";
import { resolveLayoutFileName } from "./tokens";
import { LAYOUT_VARIANT_PREFIX } from "./variant-keys";

// =====================================================
// File-name collision analysis (Output Builder → "File names" tab).
//
// A layout that splits per EAN emits ONE PDF PER REPETITION ROW, but the
// custom Settings → fileName expression is resolved against each row
// independently. When the expression contains no token that actually VARIES
// across the rows, every document resolves to the SAME name — and since the
// supplier push PUTs by name, the last one wins and the rest are silently
// lost. Nothing downstream notices: the runner stores N distinct JobAssets,
// the review page shows N cards, and only the SharePoint folder ends up short.
//
// This module answers two questions, deliberately kept separate because they
// cost very different amounts:
//
//   scanFilenameCollisions()  — cheap, SQL-only. "Where has this ALREADY
//     happened?" Groups the most recent job per style by (job, fileName) and
//     reports every group holding more than one document. Reflects what was
//     really generated (and therefore really delivered), not a simulation.
//
//   analyseStyleFilenames()   — expensive, one style. "WHY are these two
//     indistinguishable, and which token would separate them?" Re-resolves
//     the layout's CURRENT expression against the style's live repetition
//     rows, so a template that was just fixed shows as resolved without
//     regenerating anything.
//
// The second is the point of the tab: a collision is only actionable once you
// know whether {{size}} is enough or whether the rows differ solely by EAN.
// =====================================================

// Rules (which token separates a collision, and how to phrase the fix) live
// in the DB-free leaf module so tests can import them without Prisma.
export * from "./filename-collision-rules";
import {
  suggestFix,
  describeSuggestion,
  varyingTokens,
  suffixFor,
  type CandidateToken,
  type RepetitionRow,
  type CollisionGroup,
  type StyleAnalysis,
} from "./filename-collision-rules";

// Live re-resolve of ONE style against ONE layout's current expression.
// Returns null when the layout doesn't split (single file — cannot collide)
// or has no custom expression (runner default already carries the suffix).
export async function analyseStyleFilenames(
  styleId: string,
  layoutId: string,
): Promise<StyleAnalysis | null> {
  const [layout, style] = await Promise.all([
    db.outputLayout.findUnique({ where: { id: layoutId }, select: { definition: true } }),
    db.style.findUnique({
      where: { id: styleId },
      select: { id: true, name: true, poNumber: true },
    }),
  ]);
  if (!layout || !style) return null;

  let settings: LayoutSettings;
  try {
    settings = layoutSettings(parseLayoutDef(layout.definition));
  } catch {
    return null;
  }
  if (settings.repeatBy === "none" || settings.splitBy !== "ean") return null;
  if (!settings.fileName.trim()) return null;

  const { loadStyleRenderContext } = await import("@/lib/styles/render-context");
  const ctx = await loadStyleRenderContext(styleId);
  if (!ctx) return null;

  const seen = new Map<string, number>();
  const rows: RepetitionRow[] = repetitionStyles(ctx.styleData, settings.repeatBy).map((repStyle, i) => ({
    suffix: suffixFor(repStyle, settings.repeatBy, i, seen),
    size: repStyle.sizes[0]?.label ?? "",
    colourName: repStyle.colour?.name ?? "",
    ean13: repStyle.eanVariants?.[0]?.ean13 ?? repStyle.sizes[0]?.ean13 ?? "",
    cartonEan: repStyle.carton?.ean13 ?? "",
    fileName: resolveLayoutFileName(settings.fileName, repStyle),
  }));

  // Group by resolved name; anything holding >1 row is a real collision.
  const byName = new Map<string, RepetitionRow[]>();
  for (const r of rows) {
    if (!r.fileName) continue;
    const arr = byName.get(r.fileName) ?? [];
    arr.push(r);
    byName.set(r.fileName, arr);
  }

  const collisions: CollisionGroup[] = [];
  for (const [fileName, group] of byName) {
    if (group.length < 2) continue;
    collisions.push({
      fileName,
      rows: group,
      varyingTokens: varyingTokens(group),
      suggestion: suggestFix(group),
    });
  }
  collisions.sort((a, b) => b.rows.length - a.rows.length);

  return {
    styleId: style.id,
    styleName: style.name,
    poNumber: style.poNumber,
    expression: settings.fileName,
    rows,
    collisions,
  };
}

// Two independent axes, and conflating them sends the operator to the wrong
// screen:
//
//   "broken"  — today's expression STILL collides. Editing the layout is the
//               fix; regenerating first would just re-lose the same files.
//   "stale"   — the expression has since been fixed (live re-check is clean)
//               but the affected styles were generated under the OLD one, so
//               the supplier folder is still short. Regeneration is the fix,
//               and touching the template would be wrong.
//   "unknown" — the representative style could not be re-resolved (deleted,
//               unreadable render context). Shown as-is rather than guessed.
export type LayoutVerdict = "broken" | "stale" | "unknown";

export type LayoutCollisionSummary = {
  layoutId: string;
  layoutName: string;
  expression: string;
  verdict: LayoutVerdict;
  // Populated for "broken": the minimal token set that would separate the
  // representative style's rows, plus the rows themselves so the tab can show
  // WHY without a second round-trip.
  suggestion: CandidateToken[] | null;
  // describeSuggestion() already phrased against this layout's expression —
  // resolved server-side so the tab renders one sentence, not the logic.
  fix: string;
  sampleAnalysis: StyleAnalysis | null;
  // Documents that were overwritten — the count of files that never survived
  // in the supplier folder (group size minus the one that won).
  filesLost: number;
  stylesAffected: number;
  // A few representative styles for the drill-down, newest job first.
  samples: Array<{ styleId: string; styleName: string; fileName: string; docCount: number }>;
};

// Cheap SQL scan over the LATEST job per style. Deliberately not a re-render:
// this reports what actually happened, so a style whose files were already
// lost stays visible until it is regenerated with a fixed template.
export async function scanFilenameCollisions(opts?: {
  sampleCap?: number;
  // Re-resolve one representative style per layout to decide broken-vs-stale.
  // Costs a render-context load per affected layout (~2-3s all in), so the
  // callers that only need "is there anything to look at" (the tab badge on
  // the Layouts view) turn it off and every verdict stays "unknown".
  liveVerdicts?: boolean;
}): Promise<LayoutCollisionSummary[]> {
  const sampleCap = opts?.sampleCap ?? 5;
  const liveVerdicts = opts?.liveVerdicts ?? true;
  const rows = await db.$queryRaw<
    Array<{
      layoutId: string | null;
      styleId: string;
      styleName: string;
      fileName: string;
      docCount: bigint;
    }>
  >`
    with latest as (
      select distinct on (j."styleId") j.id as job_id, j."styleId"
      from jobs j
      where j.status <> 'FAILED'
      order by j."styleId", j."createdAt" desc
    )
    select
      nullif(split_part(split_part(a."variantKey", '#', 1), ':', 2), '') as "layoutId",
      l."styleId" as "styleId",
      s.name as "styleName",
      a."fileName" as "fileName",
      count(*) as "docCount"
    from job_assets a
    join latest l on l.job_id = a."jobId"
    join styles s on s.id = l."styleId"
    where a."variantKey" like ${`${LAYOUT_VARIANT_PREFIX}%`} and a."variantKey" like '%#%'
    group by 1, 2, 3, 4
    having count(*) > 1
  `;

  const byLayout = new Map<string, LayoutCollisionSummary>();
  const styleIdsByLayout = new Map<string, Set<string>>();

  for (const r of rows) {
    if (!r.layoutId) continue;
    const entry = byLayout.get(r.layoutId) ?? {
      layoutId: r.layoutId,
      layoutName: r.layoutId,
      expression: "",
      verdict: "unknown" as LayoutVerdict,
      suggestion: null,
      fix: "",
      sampleAnalysis: null,
      filesLost: 0,
      stylesAffected: 0,
      samples: [],
    };
    entry.filesLost += Number(r.docCount) - 1;
    if (entry.samples.length < sampleCap) {
      entry.samples.push({
        styleId: r.styleId,
        styleName: r.styleName,
        fileName: r.fileName,
        docCount: Number(r.docCount),
      });
    }
    byLayout.set(r.layoutId, entry);

    const ids = styleIdsByLayout.get(r.layoutId) ?? new Set<string>();
    ids.add(r.styleId);
    styleIdsByLayout.set(r.layoutId, ids);
  }

  if (byLayout.size === 0) return [];

  // Name + current expression, so the tab can show whether the template has
  // ALREADY been fixed (expression now varies) while old jobs still show the
  // historical damage.
  const layouts = await db.outputLayout.findMany({
    where: { id: { in: [...byLayout.keys()] } },
    select: { id: true, name: true, definition: true },
  });
  for (const l of layouts) {
    const entry = byLayout.get(l.id);
    if (!entry) continue;
    entry.layoutName = l.name;
    try {
      entry.expression = layoutSettings(parseLayoutDef(l.definition)).fileName;
    } catch {
      entry.expression = "";
    }
  }

  for (const [layoutId, ids] of styleIdsByLayout) {
    const entry = byLayout.get(layoutId);
    if (entry) entry.stylesAffected = ids.size;
  }

  // Live re-check, ONE representative style per layout. This is what separates
  // "edit the template" from "just regenerate" — the historical scan alone
  // can't tell them apart, because a fixed template leaves the old damage in
  // place. Bounded to one style per layout so the tab stays a page load, not a
  // sweep; the per-style drill-down re-checks the rest on demand.
  if (liveVerdicts) await Promise.all(
    [...byLayout.values()].map(async (entry) => {
      const sample = entry.samples[0];
      if (!sample) return;
      try {
        const analysis = await analyseStyleFilenames(sample.styleId, entry.layoutId);
        if (!analysis) return; // no longer a splitting layout / no custom expression
        entry.sampleAnalysis = analysis;
        if (analysis.collisions.length > 0) {
          entry.verdict = "broken";
          entry.suggestion = analysis.collisions[0].suggestion;
          entry.fix = describeSuggestion(entry.suggestion, analysis.expression);
        } else {
          entry.verdict = "stale";
          entry.fix = `Re-run the ${entry.stylesAffected} affected style(s) to replace the old files.`;
        }
      } catch {
        // Leave "unknown" — an unreadable style must not blank the whole tab.
      }
    }),
  );

  // Broken first (needs a template edit), then by damage done.
  const rank: Record<LayoutVerdict, number> = { broken: 0, unknown: 1, stale: 2 };
  return [...byLayout.values()].sort(
    (a, b) => rank[a.verdict] - rank[b.verdict] || b.filesLost - a.filesLost,
  );
}
