// scripts/perf/parity-styles-list.ts
//
// Proves the /styles list builds the same rows from SQL-projected rawData as
// from the full Monday item — for EVERY style in DATABASE_URL, not just the
// active set. Read-only.
//
//   DATABASE_URL=... npx tsx scripts/perf/parity-styles-list.ts [--chunk 500]
//
// Every table column is switched on, so every resolved spec field and both
// opt-in rollups are built. Per chunk of styles it compares three builds of
// the same rows:
//   • projected — the page's path: selected columns + rawData projected in SQL
//   • full      — the same path with the whole rawData
//   • legacy    — the pre-projection query (`include`, every Style scalar,
//                 customer / prod spec joined per row) through the same row
//                 builder
// plus the SQL projection against its JS twin (projectRawData). Exits 1 on any
// difference.

import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { getAutoGenerateEnabled, getDoneGroupPoCutoff } from "@/lib/settings/app-settings";
import { resolveDoneCutoffIds } from "@/lib/styles/active-filter";
import { STYLE_TABLE_COLUMNS } from "@/lib/styles/table-columns";
import {
  buildStyleListRow,
  customerConfigCache,
  loadStyleListContext,
  loadStyleListRows,
} from "@/lib/styles/list-rows";
import {
  listPathColumnIds,
  loadProjectedRawData,
  projectRawData,
} from "@/lib/styles/rawdata-projection";
import type { StyleListRow } from "@/lib/styles/table-row";

type Base = Omit<Parameters<typeof loadStyleListRows>[0], "rawData">;

// The /styles query as it was before the explicit select: `include` with no
// `select`, so every Style scalar (rawData included) plus the joined rows.
async function legacyRows(base: Base): Promise<StyleListRow[]> {
  const styles = await db.style.findMany({
    where: base.where,
    include: {
      customer: { select: { name: true, config: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { name: true, country: true, sharepointUrl: true } },
      prodSpec: {
        select: { id: true, name: true, autoGenerateThresholdPct: true, active: true, outputs: true },
      },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
    orderBy: [{ poSeq: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
  });
  const ctx = await loadStyleListContext(styles, base);
  return styles.map((s) => buildStyleListRow(s, s.customer, s.prodSpec, ctx));
}

// First differing path between two JSON-ish values, for the report.
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`,
      );
      if (d) return d;
    }
  }
  const show = (v: unknown) => (JSON.stringify(v) ?? String(v)).slice(0, 160);
  return `${path}: ${show(a)} !== ${show(b)}`;
}

const failures: string[] = [];
function fail(msg: string) {
  failures.push(msg);
  if (failures.length <= 50) console.error(`DIFF ${msg}`);
}

type Outcome = { rows: StyleListRow[] } | { error: string };
async function attempt(run: () => Promise<StyleListRow[]>): Promise<Outcome> {
  try {
    return { rows: await run() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function compareRows(label: string, a: StyleListRow[], b: StyleListRow[]) {
  const ids = (rows: StyleListRow[]) => rows.map((r) => r.id).join(",");
  if (ids(a) !== ids(b)) fail(`${label}: row set / order differs`);
  const byId = new Map(b.map((r) => [r.id, r]));
  for (const r of a) {
    const other = byId.get(r.id);
    if (!other) continue;
    const d = firstDiff(r, other);
    if (d) fail(`${label} style ${r.id}: ${d}`);
  }
}

async function checkChunk(ids: string[], base: Omit<Base, "where">): Promise<{ fullBytes: number; projectedBytes: number }> {
  const b: Base = { ...base, where: { id: { in: ids } } };
  const [projected, full, legacy] = await Promise.all([
    attempt(() => loadStyleListRows({ ...b, rawData: "projected" })),
    attempt(() => loadStyleListRows({ ...b, rawData: "full" })),
    attempt(() => legacyRows(b)),
  ]);
  const outcomes = { projected, full, legacy };
  if ("error" in projected || "error" in full || "error" in legacy) {
    // A style that throws (e.g. an invalid customer config) must throw the
    // same way on every path. Narrow to single styles so one bad row can't
    // hide the rest of its chunk.
    if (ids.length > 1) {
      let fullBytes = 0;
      let projectedBytes = 0;
      for (const id of ids) {
        const r = await checkChunk([id], base);
        fullBytes += r.fullBytes;
        projectedBytes += r.projectedBytes;
      }
      return { fullBytes, projectedBytes };
    }
    const msgs = Object.entries(outcomes).map(([k, o]) => `${k}=${"error" in o ? o.error : "ok"}`);
    const errs = new Set(Object.values(outcomes).map((o) => ("error" in o ? o.error : "ok")));
    if (errs.size > 1) fail(`style ${ids[0]}: paths disagree — ${msgs.join(" | ")}`);
    else console.warn(`style ${ids[0]}: throws identically on every path (${[...errs][0]})`);
    return { fullBytes: 0, projectedBytes: 0 };
  }
  compareRows("projected vs full", projected.rows, full.rows);
  compareRows("full vs legacy", full.rows, legacy.rows);

  // The SQL projection against its JS twin, on the raw items themselves.
  const styles = await db.style.findMany({
    where: { id: { in: ids } },
    select: { id: true, customerId: true, rawData: true, customer: { select: { config: true } } },
  });
  const configFor = customerConfigCache();
  const columnIds = listPathColumnIds(
    [...new Map(styles.map((s) => [s.customerId, s.customer.config])).entries()].map(
      ([id, config]) => configFor(id, config).columnMapping,
    ),
  );
  const sqlProjected = await loadProjectedRawData(ids, columnIds);
  const idSet = new Set(columnIds);
  let fullBytes = 0;
  let projectedBytes = 0;
  for (const s of styles) {
    const sql = sqlProjected.get(s.id);
    const d = firstDiff(sql, projectRawData(s.rawData, idSet));
    if (d) fail(`SQL vs JS projection style ${s.id}: ${d}`);
    fullBytes += JSON.stringify(s.rawData)?.length ?? 0;
    projectedBytes += JSON.stringify(sql)?.length ?? 0;
  }
  return { fullBytes, projectedBytes };
}

async function main() {
  const chunkArg = process.argv.indexOf("--chunk");
  const chunkSize = chunkArg > 0 ? Number(process.argv[chunkArg + 1]) : 500;
  const t0 = Date.now();
  await ensureLayoutVariantsLoaded();

  const [autoGenerateEnabled, doneCutoff, withPdfs] = await Promise.all([
    getAutoGenerateEnabled(),
    getDoneGroupPoCutoff(),
    db.job.findMany({
      where: { status: { not: "FAILED" }, assets: { some: {} } },
      select: { styleId: true },
      distinct: ["styleId"],
    }),
  ]);
  const stylesWithPdfs = new Set(withPdfs.map((j) => j.styleId));
  const doneCutoffIds = await resolveDoneCutoffIds(doneCutoff);
  const base = {
    visibleColumns: STYLE_TABLE_COLUMNS.map((c) => c.key),
    autoGenerateEnabled,
    stylesWithPdfs,
    doneCutoffIds,
  };

  const allIds = (await db.style.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((s) => s.id);
  let fullBytes = 0;
  let projectedBytes = 0;
  for (let i = 0; i < allIds.length; i += chunkSize) {
    const r = await checkChunk(allIds.slice(i, i + chunkSize), base);
    fullBytes += r.fullBytes;
    projectedBytes += r.projectedBytes;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${Math.min(i + chunkSize, allIds.length)}/${allIds.length} styles checked`);
    }
  }
  if (process.stdout.isTTY) process.stdout.write("\n");

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(
    `rawData JSON: full ${mb(fullBytes)} → projected ${mb(projectedBytes)} ` +
      `(${fullBytes ? ((100 * projectedBytes) / fullBytes).toFixed(1) : "0"}%)`,
  );
  console.log(`styles with PDFs: ${stylesWithPdfs.size} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} difference(s) across ${allIds.length} styles`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${allIds.length} styles — projected, full and legacy rows identical`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
