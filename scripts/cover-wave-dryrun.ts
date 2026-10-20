// scripts/cover-wave-dryrun.ts
//
// READ-ONLY preview of the "cover page as soon as the PO number lands" rule:
// which styles would get a first-cover run once it is deployed, grouped by
// customer · business area, and how many of those covers would go straight to
// the supplier's folder. No writes, no enqueues, no renders.
//
//   tsx --env-file=.env scripts/cover-wave-dryrun.ts            # summary
//   tsx --env-file=.env scripts/cover-wave-dryrun.ts --styles   # + one line per style
//
// Uses the SAME gate the generator uses (decideCoverRun) and the same
// supplier-send rules as enqueueCoverForSupplier, so the numbers can't drift
// from what the merge would actually do.

import { db } from "@/lib/db";
import { decideCoverRun, type CoverRunSkip } from "@/lib/queue/cover-run-gate";
import { selectRunOutputs } from "@/lib/queue/select-outputs";
import { HAS_PO_NUMBER_WHERE } from "@/lib/styles/active-filter";
import { isDeliverablePo } from "@/lib/publish/supplier-send-cutoff";
import { parseCustomerConfig } from "@/lib/customers/config";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import {
  getAutoGenerateEnabled,
  getGenerationMinPo,
  getSupplierSendMinPo,
} from "@/lib/settings/app-settings";

type Group = {
  generate: number;
  coverOnly: number;
  shipNow: number;
  parked: number; // below the generation PO cutoff
  skipped: Partial<Record<CoverRunSkip, number>>;
  styles: string[];
};

const SKIP_LABEL: Partial<Record<CoverRunSkip, string>> = {
  auto_off: "auto-generate off",
  no_outputs: "spec has no outputs",
  floated: "failed 3× (floated)",
};

async function main() {
  const listStyles = process.argv.includes("--styles");
  const [autoGenerateEnabled, genMinPo, sendMinPo] = await Promise.all([
    getAutoGenerateEnabled(),
    getGenerationMinPo(),
    getSupplierSendMinPo(),
  ]);

  // Every style with a PO number and no cover yet (no non-FAILED job carrying
  // one) and nothing in flight — the rule's whole candidate set, ACTIVE specs
  // only. Inactive / missing specs are counted separately below.
  const noCoverWhere = {
    ...HAS_PO_NUMBER_WHERE,
    jobs: {
      none: {
        OR: [
          { status: { in: ["QUEUED", "RUNNING"] as ("QUEUED" | "RUNNING")[] } },
          { status: { not: "FAILED" as const }, assets: { some: { variantKey: COVER_VARIANT_KEY } } },
        ],
      },
    },
  };
  const [styles, inactiveSpec, noSpec] = await Promise.all([
    db.style.findMany({
      where: { ...noCoverWhere, prodSpec: { is: { active: true } } },
      select: {
        id: true,
        name: true,
        poNumber: true,
        poSeq: true,
        supplierId: true,
        customer: { select: { name: true, config: true } },
        businessAreaRef: { select: { name: true } },
        businessArea: true,
        prodSpec: { select: { active: true, coverOnly: true, outputs: true, updatedAt: true } },
      },
    }),
    db.style.count({ where: { ...noCoverWhere, prodSpec: { is: { active: false } } } }),
    db.style.count({ where: { ...noCoverWhere, prodSpecId: null } }),
  ]);
  const ids = styles.map((s) => s.id);

  const [failed, withOutputs, manual] = await Promise.all([
    db.job.findMany({
      where: { styleId: { in: ids }, status: "FAILED" },
      select: { styleId: true, createdAt: true },
    }),
    db.jobAsset.findMany({
      where: {
        job: { styleId: { in: ids }, status: { not: "FAILED" } },
        variantKey: { notIn: [COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY], not: null },
      },
      select: { job: { select: { styleId: true } } },
      distinct: ["jobId"],
    }),
    db.styleManualTrimUpload
      .findMany({
        where: {
          styleId: { in: ids },
          OR: [{ NOT: { sharepointItemId: null } }, { NOT: { manualApprovedAt: null } }],
        },
        select: { styleId: true },
      })
      .catch(() => [] as { styleId: string }[]),
  ]);
  const hasOutput = new Set(withOutputs.map((a) => a.job.styleId));
  const hasManual = new Set(manual.map((m) => m.styleId));

  const groups = new Map<string, Group>();
  const totals = { generate: 0, coverOnly: 0, shipNow: 0, parked: 0, skipped: 0 };

  for (const s of styles) {
    const spec = s.prodSpec!;
    const key = `${s.customer.name} · ${s.businessAreaRef?.name ?? s.businessArea ?? "—"}`;
    const g =
      groups.get(key) ??
      ({ generate: 0, coverOnly: 0, shipNow: 0, parked: 0, skipped: {}, styles: [] } as Group);
    groups.set(key, g);

    const belowCutoff = genMinPo !== null && s.poSeq != null && s.poSeq < genMinPo;
    if (belowCutoff) {
      g.parked += 1;
      totals.parked += 1;
      continue;
    }
    const recentFailures = failed.filter(
      (f) => f.styleId === s.id && f.createdAt >= spec.updatedAt,
    ).length;
    const gate = decideCoverRun({
      hasPo: true,
      belowCutoff: false,
      prodSpec: spec,
      specHasOutputs: selectRunOutputs({ outputs: spec.outputs }).length > 0,
      autoGenerateEnabled,
      inflight: 0,
      recentFailures,
      hasCover: false,
    });
    // The sweep and the Monday paths don't run at all with auto-generate off,
    // so a cover-only style the gate admits still waits in that case.
    const skip = gate === null && !autoGenerateEnabled ? "auto_off" : gate;
    if (skip) {
      g.skipped[skip] = (g.skipped[skip] ?? 0) + 1;
      totals.skipped += 1;
      continue;
    }

    g.generate += 1;
    totals.generate += 1;
    if (spec.coverOnly) {
      g.coverOnly += 1;
      totals.coverOnly += 1;
    }
    // enqueueCoverForSupplier's gates, in its order.
    const ships =
      s.supplierId !== null &&
      !parseCustomerConfig(s.customer.config).skipSupplierDelivery &&
      isDeliverablePo(s.poSeq, sendMinPo) &&
      (hasOutput.has(s.id) || spec.coverOnly || hasManual.has(s.id));
    if (ships) {
      g.shipNow += 1;
      totals.shipNow += 1;
    }
    g.styles.push(
      `    ${ships ? "→ supplier" : "  in app  "}  PO ${s.poNumber ?? "?"}  ${s.name}${spec.coverOnly ? "  [cover only]" : ""}`,
    );
  }

  console.log("Settings now");
  console.log(`  auto-generate         : ${autoGenerateEnabled ? "ON" : "OFF"}`);
  console.log(`  generation PO cutoff  : ${genMinPo ?? "NONE (whole backlog qualifies)"}`);
  console.log(`  supplier-send cutoff  : ${sendMinPo ?? "NONE"}`);
  console.log("");
  console.log("Styles with a PO number and no cover yet, on an ACTIVE prod spec:");
  console.log(`  would get a cover run : ${totals.generate}  (of which cover-only specs: ${totals.coverOnly})`);
  console.log(`  → straight to supplier: ${totals.shipNow}`);
  console.log(`  parked below cutoff   : ${totals.parked}`);
  console.log(`  held back (reasons)   : ${totals.skipped}`);
  console.log(`Not touched: ${inactiveSpec} on an INACTIVE spec, ${noSpec} with no spec.`);
  console.log("");

  const rows = [...groups.entries()]
    .filter(([, g]) => g.generate + g.parked + Object.keys(g.skipped).length > 0)
    .sort((a, b) => b[1].generate - a[1].generate || a[0].localeCompare(b[0]));
  const w = Math.max(28, ...rows.map(([k]) => k.length));
  console.log(
    `${"Customer · Business area".padEnd(w)}  generate  cover-only  → supplier  parked  held back`,
  );
  for (const [key, g] of rows) {
    const held = Object.entries(g.skipped)
      .map(([r, n]) => `${n} ${SKIP_LABEL[r as CoverRunSkip] ?? r}`)
      .join(", ");
    console.log(
      `${key.padEnd(w)}  ${String(g.generate).padStart(8)}  ${String(g.coverOnly).padStart(10)}  ${String(
        g.shipNow,
      ).padStart(10)}  ${String(g.parked).padStart(6)}  ${held || "—"}`,
    );
    if (listStyles) for (const line of g.styles) console.log(line);
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
