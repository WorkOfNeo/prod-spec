/**
 * Auto-fit a text block on an Output Builder layout — the command-line front
 * end to src/lib/output-layouts/auto-fit (see fit-block.ts for the algorithm).
 *
 * READ-ONLY. Layouts are edited in memory; nothing is saved. Every result is a
 * PROPOSAL: PDFs to look at plus the proposed definition as JSON. Applying one
 * is a person's call in the Output Builder.
 *
 * Guard rails: never below --min-pt (2.5); --keep-together phrases never wrap;
 * position before size. The first placement that reaches the floor wins:
 *   in-place            its own cell, or the free space the cell sits in
 *   in-place-compacted  neighbours shrink to their need and close up
 *   elsewhere           a free band elsewhere on the face, nearest first
 *   other-side          compacted onto the other side of the fold
 *   OVERSHOOT           nothing reaches the floor: the most likely layout at
 *                       the floor, overflowing, plus the budget — section
 *                       height, who holds it, what the text needs
 * The report also lists the best size every other placement would have got.
 *
 * ONE BLOCK
 *   npx tsx --env-file=.env scripts/layout-autofit.ts --layout=<id> --page=<n|title> \
 *     --block=<id|index> [--lines=<file>] [--style=<id> …] [--spec=<prodSpecId>] \
 *     [--samples=8] [--scan=40] [--min-pt=2.5] [--keep-together="Contrast Company A/S" …] [--out=<dir>]
 *
 *   --lines   replace the block's lines with this file's lines first
 *   --style   measured and pictured first, if complete (repeatable)
 *   --spec    ProdSpec whose newest live styles are scanned for samples
 *             (default: the first --style's spec)
 *   --samples complete styles to measure against (default 8)
 *   --scan    newest live styles to examine (default 40)
 *
 * Samples are COMPLETE styles only: every token on the face resolves (the
 * builder's "missing on this style" check), except tokens no scanned style
 * fills. Left-out styles and what they miss are listed in <face>.json.
 *   --page    1-based page number or page title
 *
 * A PLAN (many faces, text edits applied first)
 *   npx tsx --env-file=.env scripts/layout-autofit.ts --plan=<plan.json> [--only=<jobId>] [same options]
 *
 *   [{ "id": "…", "layoutId": "…", "styleId": "…",
 *      "prodSpecId": "…" | "spec": ["<customer name>", "<business area name>"],
 *      "keepTogether": ["…"],                          (optional, adds to --keep-together)
 *      "ops": [{ "page": "Page 1", "kind": "replacePara", "match": "{{logo:contrastAddress}}", "lines": ["…"] },
 *              { "page": "Page 1", "kind": "dropLine", "match": "Produced in {{country:en}}" }] }]
 *
 *   replacePara swaps the paragraph (run of non-blank lines) holding `match`
 *   for `lines`, and that block is auto-fitted; dropLine / dropPara remove a
 *   line / paragraph. Each replacePara is one face in the output.
 *
 * Output (default ./autofit-out): <face>.json (strategy, sizes, budget, the
 * proposed definition), <face>.before.pdf, <face>.proposal.pdf and, when it
 * overshoots, <face>.proposal-fullest.pdf on the style that prints the most.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { autoFitBlock, PLACEMENTS, type AutoFitResult } from "@/lib/output-layouts/auto-fit";
import { loadAutoFitSamples } from "@/lib/output-layouts/auto-fit/samples";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import { parseLayoutDef, type LayoutDef } from "@/lib/output-layouts/schema";
import { closeBrowser, openMeasurePage, renderPdf } from "@/lib/pdf/renderer";
import type { StyleData } from "@/lib/pdf/types";

type TextOp = { page: string; kind: "replacePara" | "dropLine" | "dropPara"; match: string; lines?: string[] };
type PlanJob = {
  id: string;
  layoutId: string;
  styleId?: string;
  prodSpecId?: string;
  spec?: [customer: string, businessArea: string];
  keepTogether?: string[];
  ops: TextOp[];
};
type Face = { pageIndex: number; blockIndex: number };

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const argsOf = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

function pageIndexOf(def: LayoutDef, ref: string): number {
  const byTitle = def.pages.findIndex((p) => (p.title || "") === ref);
  if (byTitle >= 0) return byTitle;
  const n = Number(/^(?:Page )?(\d+)$/.exec(ref)?.[1]);
  if (n >= 1 && n <= def.pages.length) return n - 1;
  throw new Error(`page "${ref}" not found`);
}

// Collapse runs of blank lines and trim blank edges after an edit.
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!l.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function applyTextOps(def: LayoutDef, ops: TextOp[]): { def: LayoutDef; faces: Face[] } {
  const d = structuredClone(def);
  const faces: Face[] = [];
  for (const op of ops) {
    const pageIndex = pageIndexOf(d, op.page);
    const blocks = d.pages[pageIndex].blocks;
    const blockIndex = blocks.findIndex((b) =>
      b.lines.some((l) => (op.kind === "dropLine" ? l.trim() === op.match.trim() : l.includes(op.match))),
    );
    if (blockIndex < 0) throw new Error(`op not applied: ${op.kind} "${op.match}" on "${op.page}"`);
    const b = blocks[blockIndex];
    const i = b.lines.findIndex((l) => (op.kind === "dropLine" ? l.trim() === op.match.trim() : l.includes(op.match)));
    if (op.kind === "dropLine") {
      b.lines.splice(i, 1);
    } else {
      let s = i;
      let e = i;
      while (s > 0 && b.lines[s - 1].trim()) s--;
      while (e < b.lines.length - 1 && b.lines[e + 1].trim()) e++;
      b.lines.splice(s, e - s + 1, ...(op.kind === "replacePara" ? (op.lines ?? []) : []));
      if (op.kind === "replacePara") faces.push({ pageIndex, blockIndex });
    }
    b.lines = tidy(b.lines);
  }
  return { def: d, faces };
}

async function specIdFor(job: Pick<PlanJob, "prodSpecId" | "spec" | "styleId">): Promise<string | null> {
  if (job.prodSpecId) return job.prodSpecId;
  if (job.spec) {
    const spec = await db.prodSpec.findFirst({
      where: { customer: { name: job.spec[0] }, businessArea: { name: job.spec[1] } },
      select: { id: true },
    });
    return spec?.id ?? null;
  }
  if (job.styleId) {
    const style = await db.style.findUnique({ where: { id: job.styleId }, select: { prodSpecId: true } });
    return style?.prodSpecId ?? null;
  }
  return null;
}

function summary(res: AutoFitResult): string {
  const best = new Map<string, number>();
  for (const c of res.candidates) best.set(c.placement, Math.max(best.get(c.placement) ?? 0, c.pt));
  const head =
    res.strategy === "overshoot"
      ? `OVERSHOOT ${String(res.pt).padStart(5)} pt`
      : `${(res.placement ?? "").padEnd(18)} ${String(res.pt).padStart(5)} pt`;
  const options = PLACEMENTS.map((p) => `${p} ${best.get(p) ?? "-"}`).join(" · ");
  const parts = [`${head} (cap ${res.capPt})`, `options: ${options}`];
  if (res.budget) {
    const b = res.budget;
    const needs = Object.entries(b.needAtMm).map(([pt, mm]) => `${mm} mm at ${pt} pt`).join(", ");
    parts.push(`\n${" ".repeat(22)}section ${b.sectionMm} mm, text gets ${b.freeMm} mm, needs ${needs}; ` +
      `held by ${b.users.map((u) => `${u.firstLine.slice(0, 24)} ${u.needMm} mm`).join(", ")} + gaps ${b.gapsMm} mm`);
  }
  return parts.join("  ");
}

async function main() {
  const outDir = arg("out") ?? "autofit-out";
  mkdirSync(outDir, { recursive: true });
  const take = Number(arg("samples") ?? 8);
  const scan = Number(arg("scan") ?? 40);
  const minPt = Number(arg("min-pt") ?? 2.5);
  const keepTogetherArg = argsOf("keep-together");

  type Work = {
    name: string;
    layoutId: string;
    before: LayoutDef;
    after: LayoutDef;
    faces: Face[];
    styleIds: string[];
    prodSpecId: string | null;
    keepTogether: string[];
  };
  const work: Work[] = [];
  const planPath = arg("plan");
  if (planPath) {
    const only = arg("only");
    const jobs = (JSON.parse(readFileSync(planPath, "utf8")) as PlanJob[]).filter((j) => !only || j.id === only);
    for (const job of jobs) {
      const row = await db.outputLayout.findUniqueOrThrow({ where: { id: job.layoutId }, select: { definition: true } });
      const before = parseLayoutDef(row.definition);
      const { def: after, faces } = applyTextOps(before, job.ops);
      work.push({
        name: job.id,
        layoutId: job.layoutId,
        before,
        after,
        faces,
        styleIds: job.styleId ? [job.styleId] : [],
        prodSpecId: await specIdFor(job),
        keepTogether: [...keepTogetherArg, ...(job.keepTogether ?? [])],
      });
    }
  } else {
    const layoutId = arg("layout");
    const pageRef = arg("page");
    const blockRef = arg("block");
    if (!layoutId || !pageRef || !blockRef) {
      console.error("Need --layout, --page and --block (or --plan). See the header of this script.");
      process.exit(2);
    }
    const row = await db.outputLayout.findUniqueOrThrow({ where: { id: layoutId }, select: { definition: true } });
    const before = parseLayoutDef(row.definition);
    const after = structuredClone(before);
    const pageIndex = pageIndexOf(after, pageRef);
    const blocks = after.pages[pageIndex].blocks;
    const blockIndex = /^\d+$/.test(blockRef) ? Number(blockRef) : blocks.findIndex((b) => b.id === blockRef);
    if (!blocks[blockIndex]) throw new Error(`block "${blockRef}" not found on page ${pageIndex + 1}`);
    const linesFile = arg("lines");
    if (linesFile) blocks[blockIndex].lines = readFileSync(linesFile, "utf8").replace(/\n$/, "").split("\n");
    const styleIds = argsOf("style");
    work.push({
      name: `${layoutId}--p${pageIndex}--b${blockIndex}`,
      layoutId,
      before,
      after,
      faces: [{ pageIndex, blockIndex }],
      styleIds,
      prodSpecId: await specIdFor({ prodSpecId: arg("spec"), styleId: styleIds[0] }),
      keepTogether: keepTogetherArg,
    });
  }

  const tab = await openMeasurePage();
  try {
    for (const w of work) {
      const keepTogether = w.keepTogether;
      const { customLogo } = await db.outputLayout.findUniqueOrThrow({ where: { id: w.layoutId }, select: { customLogo: true } });
      const pdf = async (def: LayoutDef, pageIndex: number, sd: StyleData, file: string) =>
        writeFileSync(join(outDir, file), await renderPdf({ html: await renderLayoutHtml(def, sd, { mode: "production", pageIndex, customLogo }) }));
      for (const face of w.faces) {
        const name = `${w.name}--p${face.pageIndex}`;
        const set = await loadAutoFitSamples({
          prodSpecId: w.prodSpecId,
          styleIds: w.styleIds,
          take,
          scan,
          defs: [w.before, w.after],
          completeOn: { def: w.after, pages: [face.pageIndex] },
        });
        const samples = set.samples;
        if (!samples.length) {
          console.log(`${name.padEnd(20)} no complete style among ${set.scanned} scanned — pass --style or --spec`);
          continue;
        }
        const res = await autoFitBlock({
          def: w.after,
          pageIndex: face.pageIndex,
          blockIndex: face.blockIndex,
          samples,
          evaluate: tab.evaluate,
          renderOptions: { customLogo },
          options: { minPt, keepTogether, exploreAll: true },
        });
        await pdf(w.before, face.pageIndex, samples[0].styleData, `${name}.before.pdf`);
        await pdf(res.def, face.pageIndex, samples[0].styleData, `${name}.proposal.pdf`);
        if (res.strategy === "overshoot") {
          await pdf(res.def, face.pageIndex, samples[res.fullestSample].styleData, `${name}.proposal-fullest.pdf`);
        }
        writeFileSync(
          join(outDir, `${name}.json`),
          JSON.stringify(
            {
              layoutId: w.layoutId,
              pageIndex: face.pageIndex,
              blockIndex: face.blockIndex,
              samples: samples.map((s) => s.label),
              scanned: set.scanned,
              neverFilled: set.neverFilled,
              incomplete: set.incomplete,
              strategy: res.strategy,
              pt: res.pt,
              capPt: res.capPt,
              placement: res.placement,
              keepTogether,
              candidates: res.candidates.map((c) => ({ placement: c.placement, pt: c.pt, shiftMm: c.shiftMm, compacted: c.compacted })),
              budget: res.budget,
              fullestSample: samples[res.fullestSample].label,
              space: res.space,
              definition: res.def,
            },
            null,
            1,
          ),
        );
        console.log(`${name.padEnd(20)} ${summary(res)}  [${samples.length} complete of ${set.scanned} scanned]`);
      }
    }
  } finally {
    await tab.close();
    await closeBrowser();
    await db.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser();
  await db.$disconnect();
  process.exit(1);
});
