/**
 * Oversized care labels — which CARE_LABEL outputs print TALLER than a
 * threshold (default 60 mm), tallest first.
 *
 * READ-ONLY. Every query here is a findMany/findUnique; nothing writes.
 *
 * WHY THIS ISN'T ONE QUERY
 * ------------------------
 * The printed height of a layout is decided in THREE different places, and a
 * report that reads only the obvious one under-reports badly:
 *
 *   1. OutputLayout.definition → page.heightMm — the layout's own authored page
 *      size (LayoutPageSchema bounds: 5–1000 mm). This is the height for every
 *      NON-info-area layout, always.
 *   2. InfoAreaSize.heightMm — a layout flagged `isInfoArea` prints at a size
 *      the operator PICKS per output (ProdSpecOutput.infoAreaSizeId). The
 *      layout's own page size is then irrelevant: effectiveOutputDims resolves
 *      the admin size LIVE, so an edit to the named size moves every output
 *      that picked it.
 *   3. The per-output custom size — an info-area output with NO named pick
 *      falls back to ProdSpecOutput.widthMm/heightMm, a one-time value typed on
 *      the style card. Also the landing place when a picked size was deleted or
 *      deactivated.
 *
 * Whatever (2) or (3) resolves to is handed to the renderer as
 * `sizeOverrideMm`, which rewrites EVERY page of the layout and is clamped to
 * 5–1000 mm by clampMm (src/lib/output-layouts/render.ts). We reproduce that
 * clamp here so the reported height is the height that actually prints, not the
 * number someone typed.
 *
 * Because (2) and (3) are per-output, ONE info-area layout can print at several
 * different heights across the estate. Those are listed as sub-rows under the
 * layout, and the layout sorts by its TALLEST resolved height — the worst case
 * is what decides whether it's worth opening.
 *
 * WHY NOT `name LIKE '%care%'`
 * ---------------------------
 * Layouts are named "<Customer> - <Business area> - <Document>" and the
 * <Document> tail is spelled ~30 ways across customers ("Wash Care", "Care
 * Label", "OEKO-TEX label", …). A substring match misses most of them and
 * catches things that aren't care labels. So membership is decided by the
 * CARE_LABEL concept via classifyLayoutName (src/lib/trims/classify.ts), using
 * the SAME stored rules the /settings/trims screen edits — the report and the
 * settings screen can't disagree.
 *
 *   npx tsx --env-file=.env scripts/tall-care-labels-report.ts
 *   npx tsx --env-file=.env scripts/tall-care-labels-report.ts --threshold=45
 *   npx tsx --env-file=.env scripts/tall-care-labels-report.ts --all
 *   npx tsx --env-file=.env scripts/tall-care-labels-report.ts --published
 *   npx tsx --env-file=.env scripts/tall-care-labels-report.ts --json
 */
import { db } from "@/lib/db";
import { getTrimRules } from "@/lib/settings/app-settings";
import { classifyLayoutName } from "@/lib/trims/classify";
import { parseLayoutDef } from "@/lib/output-layouts/schema";
import { layoutVariantKey } from "@/lib/output-layouts/variant-keys";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { isArchivedGroup } from "@/lib/import/heuristics";

const DEFAULT_THRESHOLD_MM = 60;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showAll = args.includes("--all");
const publishedOnly = args.includes("--published");
const thresholdArg = args.find((a) => a.startsWith("--threshold="));
const thresholdMm = thresholdArg ? Number(thresholdArg.split("=")[1]) : DEFAULT_THRESHOLD_MM;

if (!Number.isFinite(thresholdMm) || thresholdMm <= 0) {
  console.error(`Invalid --threshold: ${thresholdArg}`);
  process.exit(1);
}

// Same clamp the renderer applies to a size override (render.ts clampMm) — a
// stray stored value can't print outside the LayoutPage bounds, so the report
// must not claim it does.
function clampMm(mm: number): number {
  if (!Number.isFinite(mm)) return 5;
  return Math.min(1000, Math.max(5, mm));
}

// Where a printed height came from, in the renderer's own precedence order.
type HeightSource = "layout page size" | "info-area named size" | "info-area custom size";

type SizeRow = {
  heightMm: number;
  widthMm: number;
  source: HeightSource;
  // The named InfoAreaSize, when that's what decided it.
  sizeName: string | null;
  // Prod Specs resolving to this height, and the styles under them.
  prodSpecs: string[];
  activeStyles: number;
  totalStyles: number;
};

type LayoutRow = {
  layoutId: string;
  name: string;
  status: string;
  docType: string;
  customer: string;
  businessArea: string;
  isInfoArea: boolean;
  pageCount: number;
  // The layout's OWN authored height — the tallest page, since a multi-page
  // layout is only as printable as its tallest sheet.
  authoredHeightMm: number | null;
  // Worst case across every way this layout actually prints.
  maxPrintedHeightMm: number;
  sizes: SizeRow[];
  activeStyles: number;
  totalStyles: number;
};

async function main() {
  const rules = await getTrimRules();

  const layouts = await db.outputLayout.findMany({
    where: publishedOnly ? { status: "PUBLISHED" } : {},
    select: {
      id: true,
      name: true,
      status: true,
      docType: true,
      isInfoArea: true,
      definition: true,
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
    },
  });

  // CARE_LABEL by concept, never by substring — see the header.
  const careLabels = layouts.filter((l) => classifyLayoutName(l.name, rules) === "CARE_LABEL");
  if (careLabels.length === 0) {
    console.log("No layouts classify as CARE_LABEL. Check /settings/trims — the rule set may have been edited.");
    await db.$disconnect();
    return;
  }
  const careLabelIds = new Set(careLabels.map((l) => l.id));

  // Source 2: every named size, active AND inactive. A frozen pick to a
  // now-inactive size still resolves at render time (loadInfoAreaSizeMap does
  // the same), so filtering on `active` would silently drop real print sizes.
  const infoAreaSizes = await db.infoAreaSize.findMany({
    select: { id: true, name: true, widthMm: true, heightMm: true },
  });
  const sizeById = new Map(infoAreaSizes.map((s) => [s.id, s]));

  // Layouts are linked to Prod Specs only through the `layout:<id>` variantKey
  // inside the outputs JSON — no FK — so the join happens in memory.
  const specs = await db.prodSpec.findMany({
    select: {
      id: true,
      name: true,
      outputs: true,
      customer: { select: { name: true } },
      businessArea: { select: { name: true } },
    },
  });

  // TWO style counts per spec, deliberately, because one of them lies on its
  // own. ~93% of the estate sits in Monday's "Done" group, so an active-only
  // count reads as "nobody uses this" for a layout that has printed hundreds of
  // labels, while a total-only count reads as urgent for finished work. ACTIVE
  // (isArchivedGroup: Done / Cancelled / Archived / Templates filtered out) is
  // the manual work in front of you; TOTAL is the blast radius if the layout is
  // re-run or the size is changed retroactively.
  const styles = await db.style.findMany({
    where: { prodSpecId: { not: null } },
    select: { id: true, prodSpecId: true, groupTitle: true },
  });
  const styleIdsBySpec = new Map<string, { active: string[]; all: string[] }>();
  for (const s of styles) {
    if (!s.prodSpecId) continue;
    const entry = styleIdsBySpec.get(s.prodSpecId) ?? { active: [], all: [] };
    entry.all.push(s.id);
    if (!isArchivedGroup(s.groupTitle)) entry.active.push(s.id);
    styleIdsBySpec.set(s.prodSpecId, entry);
  }

  // A per-style Ignore takes the output off that style entirely — it never
  // generates and never ships — so those styles are not manual work either.
  const careLabelKeys = [...careLabelIds].map((id) => layoutVariantKey(id));
  const ignores =
    careLabelKeys.length === 0
      ? []
      : await db.styleOutputIgnore.findMany({
          where: { variantKey: { in: careLabelKeys } },
          select: { styleId: true, variantKey: true },
        });
  const ignoredByKey = new Map<string, Set<string>>();
  for (const ig of ignores) {
    const set = ignoredByKey.get(ig.variantKey) ?? new Set<string>();
    set.add(ig.styleId);
    ignoredByKey.set(ig.variantKey, set);
  }

  const rows: LayoutRow[] = [];

  for (const layout of careLabels) {
    // Source 1: the layout's own authored page size. An unparseable definition
    // is reported rather than skipped — a layout nobody can render is itself a
    // finding, and silently dropping it would understate the list.
    let authoredHeightMm: number | null = null;
    let authoredWidthMm: number | null = null;
    let pageCount = 0;
    try {
      const def = parseLayoutDef(layout.definition);
      pageCount = def.pages.length;
      const tallest = def.pages.reduce((a, b) => (b.heightMm > a.heightMm ? b : a));
      authoredHeightMm = tallest.heightMm;
      authoredWidthMm = tallest.widthMm;
    } catch {
      // Leaves authoredHeightMm null; flagged in the output.
    }

    const variantKey = layoutVariantKey(layout.id);
    const ignored = ignoredByKey.get(variantKey) ?? new Set<string>();

    // One bucket per distinct printed size, so an info-area layout that prints
    // at three different heights across the estate reads as three sub-rows.
    const buckets = new Map<string, SizeRow>();
    const addBucket = (
      heightMm: number,
      widthMm: number,
      source: HeightSource,
      sizeName: string | null,
      specLabel: string | null,
      activeStyles: number,
      totalStyles: number,
    ) => {
      const key = `${source}|${sizeName ?? ""}|${widthMm}x${heightMm}`;
      const bucket = buckets.get(key) ?? {
        heightMm,
        widthMm,
        source,
        sizeName,
        prodSpecs: [],
        activeStyles: 0,
        totalStyles: 0,
      };
      if (specLabel && !bucket.prodSpecs.includes(specLabel)) bucket.prodSpecs.push(specLabel);
      bucket.activeStyles += activeStyles;
      bucket.totalStyles += totalStyles;
      buckets.set(key, bucket);
    };

    let activeStyles = 0;
    let totalStyles = 0;

    for (const spec of specs) {
      let outputs;
      try {
        outputs = parseProdSpecOutputs(spec.outputs);
      } catch {
        continue; // A malformed spec can't tell us anything about print size.
      }
      const output = outputs.find((o) => o.variantKey === variantKey && o.enabled);
      if (!output) continue;

      const specEntry = styleIdsBySpec.get(spec.id) ?? { active: [], all: [] };
      const specActive = specEntry.active.filter((id) => !ignored.has(id)).length;
      const specTotal = specEntry.all.filter((id) => !ignored.has(id)).length;
      activeStyles += specActive;
      totalStyles += specTotal;
      const specLabel = spec.name || `${spec.customer.name} · ${spec.businessArea.name}`;

      // The renderer's precedence, reproduced exactly (effectiveOutputDims →
      // sizeOverrideMm → clampMm). Non-info-area outputs ignore the ProdSpec
      // dims entirely: the layout's page size is the print size.
      if (layout.isInfoArea) {
        const named = output.infoAreaSizeId ? sizeById.get(output.infoAreaSizeId) : undefined;
        if (named) {
          addBucket(
            clampMm(named.heightMm),
            clampMm(named.widthMm),
            "info-area named size",
            named.name,
            specLabel,
            specActive,
            specTotal,
          );
        } else {
          addBucket(
            clampMm(output.heightMm),
            clampMm(output.widthMm),
            "info-area custom size",
            null,
            specLabel,
            specActive,
            specTotal,
          );
        }
      } else if (authoredHeightMm !== null && authoredWidthMm !== null) {
        addBucket(authoredHeightMm, authoredWidthMm, "layout page size", null, specLabel, specActive, specTotal);
      }
    }

    // A layout no spec references still has a printed height — its own page
    // size — and still shows up, at 0 live styles, so a not-yet-rolled-out
    // oversized care label is visible before it becomes 500 styles of rework.
    if (buckets.size === 0 && authoredHeightMm !== null && authoredWidthMm !== null) {
      addBucket(authoredHeightMm, authoredWidthMm, "layout page size", null, null, 0, 0);
    }

    const sizes = [...buckets.values()].sort((a, b) => b.heightMm - a.heightMm);
    if (sizes.length === 0) continue; // Unparseable definition AND no spec dims.

    rows.push({
      layoutId: layout.id,
      name: layout.name,
      status: layout.status,
      docType: layout.docType,
      customer: layout.customer?.name ?? "(no customer)",
      businessArea: layout.businessArea?.name ?? "(no business area)",
      isInfoArea: layout.isInfoArea,
      pageCount,
      authoredHeightMm,
      maxPrintedHeightMm: sizes[0].heightMm,
      sizes,
      activeStyles,
      totalStyles,
    });
  }

  const over = showAll ? rows : rows.filter((r) => r.maxPrintedHeightMm > thresholdMm);
  // Tallest first — biggest win at the top. Ties break on live styles, so the
  // one that costs the most manual work leads.
  over.sort(
    (a, b) =>
      b.maxPrintedHeightMm - a.maxPrintedHeightMm ||
      b.activeStyles - a.activeStyles ||
      b.totalStyles - a.totalStyles,
  );

  if (asJson) {
    console.log(JSON.stringify({ thresholdMm, careLabelLayouts: rows.length, rows: over }, null, 2));
    await db.$disconnect();
    return;
  }

  const mm = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

  console.log(
    `\nCare labels printing over ${mm(thresholdMm)} mm — ${over.length} of ${rows.length} CARE_LABEL layout(s)` +
      `${publishedOnly ? " (PUBLISHED only)" : ""}${showAll ? " (--all: no height filter)" : ""}\n`,
  );

  for (const r of over) {
    const tall = r.maxPrintedHeightMm > thresholdMm ? "" : "  (under threshold)";
    console.log(
      `${mm(r.maxPrintedHeightMm)} mm  ${r.name}${tall}\n` +
        `      customer: ${r.customer}  |  business area: ${r.businessArea}  |  ${r.docType}  |  ${r.status}` +
        `${r.isInfoArea ? "  |  INFO AREA" : ""}`,
    );
    if (r.authoredHeightMm === null) {
      console.log(`      !! layout definition does not parse — authored page size unknown`);
    } else {
      console.log(
        `      authored page: ${mm(r.authoredHeightMm)} mm tall` +
          `${r.pageCount > 1 ? ` (tallest of ${r.pageCount} pages)` : ""}`,
      );
    }
    console.log(`      styles using it: ${r.activeStyles} active / ${r.totalStyles} total`);
    for (const s of r.sizes) {
      const named = s.sizeName ? ` "${s.sizeName}"` : "";
      const specs =
        s.prodSpecs.length === 0
          ? "no Prod Spec references this layout"
          : s.prodSpecs.length <= 3
            ? s.prodSpecs.join(", ")
            : `${s.prodSpecs.slice(0, 3).join(", ")} +${s.prodSpecs.length - 3} more`;
      console.log(
        `        - ${mm(s.widthMm)} × ${mm(s.heightMm)} mm  ←  ${s.source}${named}` +
          `  |  ${s.activeStyles} active / ${s.totalStyles} total style(s)  |  ${specs}`,
      );
    }
    console.log("");
  }

  const bySource = new Map<HeightSource, number>();
  for (const r of over) {
    // Attribute the layout to whatever decided its WORST-CASE height.
    const src = r.sizes[0].source;
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }

  console.log("---");
  console.log(`CARE_LABEL layouts examined: ${rows.length}`);
  console.log(`Printing over ${mm(thresholdMm)} mm: ${over.length}`);
  console.log(
    `Styles affected: ${over.reduce((n, r) => n + r.activeStyles, 0)} active / ` +
      `${over.reduce((n, r) => n + r.totalStyles, 0)} total`,
  );
  for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  height decided by ${src}: ${n} layout(s)`);
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
