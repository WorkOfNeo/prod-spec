// Perf probe — builds a checkout, starts it against the seeded DB and times
// the slow pages. See docs/perf/README.md.
//
//   DATABASE_URL=postgresql://postgres@localhost:5432/prodspec_p0 \
//     npx tsx scripts/perf/probe.ts <checkoutDir> <label> [--latency-ms 0,2]
//
// Options:
//   --latency-ms 0,2   comma list; every run goes through latency-proxy.ts and
//                      each value is one table (default "0,2")
//   --runs 5           timed requests per URL (after one warm-up)
//   --port 3101        app port      --proxy-port 3111   latency proxy port
//   --skip-build       reuse the checkout's existing .next build
//   --url /path        probe an extra path (repeatable)
//   --top N            also record each URL's N most frequent statements
//                      (first latency only) in a collapsible section
//   --out <dir>        where <label>.md goes (default: docs/perf next to this script)
//
// The checkout needs node_modules and a generated Prisma client — this script
// never installs anything. It kills only the server process group it started.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
// pg arrives with @prisma/adapter-pg; a raw client keeps the probe's stats
// queries off the app's Prisma client and its pool.
import pg from "pg";
import { startLatencyProxy, type LatencyProxy } from "./latency-proxy";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--latency-ms", "--runs", "--port", "--proxy-port", "--url", "--out", "--top"]);
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUE_FLAGS.has(a)) i++;
  else if (!a.startsWith("--")) positional.push(a);
}
const flag = (name: string) => process.argv.includes(name);
const opt = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const opts = (name: string) => process.argv.flatMap((a, i) => (a === name ? [process.argv[i + 1]] : []));

const [checkoutArg, label] = positional;
if (!checkoutArg || !label) {
  console.error("usage: npx tsx scripts/perf/probe.ts <checkoutDir> <label> [--latency-ms 0,2] [--runs 5] [--skip-build]");
  process.exit(2);
}
const CHECKOUT = path.resolve(checkoutArg);
const LATENCIES = opt("--latency-ms", "0,2").split(",").map(Number);
const RUNS = Number(opt("--runs", "5"));
const PORT = Number(opt("--port", "3101"));
const PROXY_PORT = Number(opt("--proxy-port", "3111"));
const TOP = Number(opt("--top", "0"));
const OUT_DIR = path.resolve(opt("--out", path.join(__dirname, "../../docs/perf")));
const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) throw new Error("DATABASE_URL not set (the seeded database, e.g. postgresql://postgres@localhost:5432/prodspec_p0)");
if (LATENCIES.some((l) => !Number.isFinite(l) || l < 0)) throw new Error("--latency-ms takes non-negative numbers, e.g. 0,2");

const dbUrl = new URL(DB_URL);
// The app talks to Postgres through the proxy; the probe's own stats queries
// go direct so they never pay (or skew) the injected latency.
const proxiedUrl = (() => {
  const u = new URL(DB_URL);
  u.hostname = "127.0.0.1";
  u.port = String(PROXY_PORT);
  return u.toString();
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ms = (x: number) => String(Math.round(x));
const kb = (bytes: number) => (bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0);

type Sample = { code: number; ttfb: number; total: number; bytes: number };

async function curl(url: string, extra: string[] = []): Promise<Sample> {
  // --noproxy: the container's HTTP(S)_PROXY must never sit between the probe
  // and localhost. No -L: a redirect is a result worth seeing, not following.
  const { stdout } = await run(
    "curl",
    ["-s", "--noproxy", "*", "-o", "/dev/null", "--max-time", "300", "-w", "%{http_code} %{time_starttransfer} %{time_total} %{size_download}", ...extra, url],
    { maxBuffer: 1 << 20 },
  );
  const [code, ttfb, total, bytes] = stdout.trim().split(" ").map(Number);
  return { code, ttfb: ttfb * 1000, total: total * 1000, bytes };
}

function preflight() {
  const need = [
    ["package.json", "not a checkout"],
    ["node_modules/.bin/next", "no node_modules — link or install them first (see docs/perf/README.md)"],
    ["src/generated/prisma/client.ts", "no generated Prisma client — run `npx prisma generate` in the checkout"],
  ];
  for (const [rel, why] of need) {
    if (!existsSync(path.join(CHECKOUT, rel))) throw new Error(`${CHECKOUT}: missing ${rel} (${why})`);
  }
}

async function gitDescribe(): Promise<string> {
  try {
    const sha = (await run("git", ["-C", CHECKOUT, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const branch = (await run("git", ["-C", CHECKOUT, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const dirty = (await run("git", ["-C", CHECKOUT, "status", "--porcelain", "--untracked-files=no"])).stdout.trim() ? " (dirty)" : "";
    return `${branch} @ ${sha}${dirty}`;
  } catch {
    return "(not a git checkout)";
  }
}

async function build(logFile: string): Promise<number> {
  const t0 = Date.now();
  console.log(`Building ${CHECKOUT} (log: ${logFile}) …`);
  const log = createWriteStream(logFile);
  const child = spawn("npm", ["run", "build"], { cwd: CHECKOUT, env: { ...process.env, DATABASE_URL: DB_URL } });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code: number = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    console.error(readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n"));
    throw new Error(`npm run build failed (exit ${code})`);
  }
  return Date.now() - t0;
}

let server: ChildProcess | null = null;
let proxy: LatencyProxy | null = null;

function startServer(logFile: string): ChildProcess {
  const log = createWriteStream(logFile);
  // detached → its own process group, so cleanup can signal exactly the
  // processes this probe started (next may fork workers) and nothing else.
  const child = spawn(path.join(CHECKOUT, "node_modules/.bin/next"), ["start", "-p", String(PORT)], {
    cwd: CHECKOUT,
    detached: true,
    env: {
      ...process.env,
      DATABASE_URL: proxiedUrl,
      AUTH_DISABLED: "true",
      // /dashboard redirects to /styles when the follow-through kill switch is
      // thrown; force it off so the probe measures the page itself.
      REVIEW_FOLLOW_THROUGH_DISABLED: "false",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "perf-probe-local-secret-not-for-production",
      BETTER_AUTH_URL: `http://localhost:${PORT}`,
      PORT: String(PORT),
    },
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

async function stopServer() {
  if (!server?.pid) return;
  const pid = server.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      process.kill(-pid, 0);
    } catch {
      server = null;
      return;
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
  server = null;
}

async function waitForServer() {
  for (let i = 0; i < 600; i++) {
    if (server?.exitCode != null) throw new Error(`next start exited with code ${server.exitCode}`);
    try {
      const s = await curl(`http://localhost:${PORT}/api/admin/dashboard/counts`);
      if (s.code > 0) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("server did not come up within 120 s");
}

// ---------------------------------------------------------------------------
// DB side
// ---------------------------------------------------------------------------

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// The style detail probe target: the in-flow style with the longest job
// history (most jobs, then most assets), ties broken by id — deterministic
// for a given seed, and the heavy end of what a reviewer opens.
const PICK_STYLE_SQL = `
  SELECT s.id
    FROM styles s
    JOIN jobs j ON j."styleId" = s.id
    JOIN job_assets a ON a."jobId" = j.id
   WHERE s."prodSpecId" IS NOT NULL AND s."archivedAt" IS NULL AND s."deletedAt" IS NULL
   GROUP BY s.id
  HAVING count(DISTINCT j.id) >= 2
   ORDER BY count(DISTINCT j.id) DESC, count(a.id) DESC, s.id
   LIMIT 1`;

const DB_FILTER = `dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND query NOT ILIKE '%pg_stat_statements%'`;

async function resetStatements(c: pg.Client) {
  // Scoped to this database: the server is shared with other probes.
  await c.query(`SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0)`);
}

// Another process on the same server calling the global
// pg_stat_statements_reset(), or entry eviction at pg_stat_statements.max,
// silently empties our counters mid-measurement. Both move this marker, so a
// changed marker means "measure again".
async function statementsEpoch(c: pg.Client): Promise<string> {
  const { rows } = await c.query(`SELECT stats_reset::text || '/' || dealloc::text AS epoch FROM pg_stat_statements_info`);
  return rows[0].epoch;
}

async function readStatements(c: pg.Client): Promise<{ calls: number; rows: number; execMs: number }> {
  const { rows } = await c.query(
    `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum(rows), 0)::bigint AS rows, coalesce(sum(total_exec_time), 0)::float AS ms
       FROM pg_stat_statements WHERE ${DB_FILTER}`,
  );
  return { calls: rows[0].calls, rows: Number(rows[0].rows), execMs: rows[0].ms };
}

type Statement = { calls: number; rows: number; ms: number; query: string };

async function topStatements(c: pg.Client, n: number): Promise<Statement[]> {
  const { rows } = await c.query(
    `SELECT calls::int, rows::bigint, total_exec_time::float AS ms, regexp_replace(query, '\\s+', ' ', 'g') AS query
       FROM pg_stat_statements WHERE ${DB_FILTER}
      ORDER BY calls DESC, total_exec_time DESC LIMIT $1`,
    [n],
  );
  return rows.map((r) => ({ calls: r.calls, rows: Number(r.rows), ms: r.ms, query: r.query }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Row = {
  path: string;
  codes: number[];
  ttfb: number[];
  total: number[];
  bytes: number;
  gzipBytes: number;
  queries: number;
  rows: number;
  dbMs: number;
  top: Statement[];
};

async function measure(urlPath: string, db: pg.Client): Promise<Row> {
  const url = `http://localhost:${PORT}${urlPath}`;
  await curl(url); // warm-up: route compile caches, module-level TTL caches
  const samples: Sample[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(await curl(url));
  const gz = await curl(url, ["-H", "Accept-Encoding: gzip"]);
  let stats: { calls: number; rows: number; execMs: number } | null = null;
  let top: Statement[] = [];
  for (let attempt = 0; attempt < 5 && !stats; attempt++) {
    const epoch = await statementsEpoch(db);
    await resetStatements(db);
    await curl(url);
    // Let anything the response kicked off after flushing land in the stats.
    await sleep(400);
    const read = await readStatements(db);
    top = TOP > 0 ? await topStatements(db, TOP) : [];
    if ((await statementsEpoch(db)) === epoch) stats = read;
  }
  if (!stats) console.warn(`  ${urlPath}: pg_stat_statements kept being reset by another client — query count unavailable`);
  return {
    path: urlPath,
    codes: [...new Set(samples.map((s) => s.code))],
    ttfb: samples.map((s) => s.ttfb),
    total: samples.map((s) => s.total),
    bytes: median(samples.map((s) => s.bytes)),
    gzipBytes: gz.bytes,
    queries: stats?.calls ?? NaN,
    rows: stats?.rows ?? NaN,
    dbMs: stats?.execMs ?? NaN,
    top,
  };
}

function topSection(rows: Row[]): string {
  const clip = (q: string) => (q.length > 220 ? `${q.slice(0, 217)}…` : q).replace(/\|/g, "\\|");
  return rows
    .filter((r) => r.top.length > 0)
    .map(
      (r) =>
        `<details><summary><code>${r.path.replace(/perf-sty-\d+/, "&lt;style&gt;")}</code> — top ${r.top.length} statements by calls</summary>\n\n` +
        "| calls | rows | exec ms | statement |\n|--:|--:|--:|---|\n" +
        r.top.map((t) => `| ${t.calls} | ${t.rows} | ${t.ms.toFixed(1)} | \`${clip(t.query)}\` |`).join("\n") +
        "\n\n</details>",
    )
    .join("\n\n");
}

function table(rows: Row[]): string {
  const head =
    "| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |\n" +
    "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|";
  const body = rows.map((r) =>
    [
      `\`${r.path.replace(/perf-sty-\d+/, "<style>")}\``,
      r.codes.join("/"),
      ms(median(r.ttfb)),
      ms(Math.min(...r.ttfb)),
      ms(Math.max(...r.ttfb)),
      ms(median(r.total)),
      ms(Math.min(...r.total)),
      ms(Math.max(...r.total)),
      kb(r.bytes),
      kb(r.gzipBytes),
      Number.isNaN(r.queries) ? "n/a" : String(r.queries),
      Number.isNaN(r.rows) ? "n/a" : String(r.rows),
      Number.isNaN(r.dbMs) ? "n/a" : r.dbMs.toFixed(0),
    ].join(" | "),
  );
  return [head, ...body.map((b) => `| ${b} |`)].join("\n");
}

async function main() {
  preflight();
  const startedAt = new Date();
  const scratch = path.join(os.tmpdir(), `perf-probe-${label}-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const buildMs = flag("--skip-build") ? null : await build(path.join(scratch, "build.log"));

  await withDb(async (c) => c.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"));
  const { styleId, dataset } = await withDb(async (c) => {
    const picked = await c.query(PICK_STYLE_SQL);
    if (picked.rowCount === 0) throw new Error("no style with ≥2 jobs and assets — seed the database first (scripts/perf/seed.ts)");
    const counts = await c.query(`
      SELECT (SELECT count(*) FROM styles) AS styles, (SELECT count(*) FROM jobs) AS jobs,
             (SELECT count(*) FROM job_assets) AS assets, (SELECT count(*) FROM monday_ghost_items) AS ghosts,
             (SELECT count(DISTINCT "styleId") FROM jobs WHERE status = 'AWAITING_REVIEW') AS awaiting,
             (SELECT round(avg(octet_length("rawData"::text)) / 1024.0, 1) FROM styles) AS raw_kb`);
    const d = counts.rows[0];
    return {
      styleId: picked.rows[0].id as string,
      dataset: `${d.styles} styles (rawData avg ${d.raw_kb} KB), ${d.jobs} jobs, ${d.assets} job assets, ${d.awaiting} styles awaiting review, ${d.ghosts} ghost items`,
    };
  });

  const paths = [
    "/dashboard",
    "/styles",
    `/styles/${styleId}`,
    "/reviews/dashboard",
    "/api/admin/dashboard/counts",
    "/api/admin/import/counts",
    ...opts("--url"),
  ];

  proxy = await startLatencyProxy({
    listenPort: PROXY_PORT,
    targetHost: dbUrl.hostname,
    targetPort: Number(dbUrl.port || 5432),
    delayMs: LATENCIES[0],
  });
  const serverLog = path.join(scratch, "server.log");
  server = startServer(serverLog);
  console.log(`next start pid ${server.pid} on :${PORT} (log: ${serverLog}), DB via latency proxy :${PROXY_PORT}`);
  await waitForServer();

  const sections: string[] = [];
  await withDb(async (db) => {
    for (const latency of LATENCIES) {
      proxy!.setDelay(latency);
      console.log(`\n— ${latency} ms per chunk each way —`);
      // Host load matters on a shared box: other builds and servers compete
      // for the same CPUs and stretch every timing below.
      const loadBefore = os.loadavg()[0];
      const rows: Row[] = [];
      for (const p of paths) {
        const r = await measure(p, db);
        rows.push(r);
        console.log(`  ${p.padEnd(34)} ${r.codes.join("/")}  total med ${ms(median(r.total))} ms  ${kb(r.bytes)} KB  ${r.queries} queries`);
      }
      const loadAfter = os.loadavg()[0];
      const t = table(rows);
      console.log(`\n${t}`);
      sections.push(
        `### Latency ${latency} ms${latency === 0 ? " (proxy pass-through)" : ` per chunk each way (≈${latency * 2} ms added per query round trip)`}\n\n` +
          `Host load average (1 min) ${loadBefore.toFixed(1)} → ${loadAfter.toFixed(1)} on ${os.cpus().length} CPUs.\n\n${t}`,
      );
      if (latency === LATENCIES[0] && TOP > 0) sections.push(`#### Statements per request (latency ${latency} ms)\n\n${topSection(rows)}`);
    }
  });

  const serverErrors = readFileSync(serverLog, "utf8")
    .split("\n")
    .filter((l) => /error|unhandled|digest/i.test(l))
    .slice(0, 15);

  const md = [
    `# Perf probe — ${label}`,
    "",
    `- Checkout: \`${CHECKOUT}\` — ${await gitDescribe()}`,
    `- Probed: ${startedAt.toISOString()} on ${os.hostname()} (${os.cpus().length} CPUs), Node ${process.version}`,
    `- Database: \`${dbUrl.pathname.slice(1)}\` — ${dataset}`,
    `- Style detail target: \`/styles/${styleId}\` (in-flow style with the longest job history)`,
    `- Method: one warm-up request per URL, then ${RUNS} sequential requests (curl, no compression) for TTFB / total / KB; one more with \`Accept-Encoding: gzip\` for KB gzip; one more after a database-scoped \`pg_stat_statements_reset\` for DB queries (sum of calls, utility statements such as BEGIN included), rows returned and server-side execution time. Times in ms.`,
    buildMs != null ? `- Build: \`npm run build\` took ${(buildMs / 1000).toFixed(0)} s` : "- Build: reused existing .next (--skip-build)",
    "",
    ...sections.flatMap((s) => [s, ""]),
    serverErrors.length
      ? `### Server log errors (first ${serverErrors.length})\n\n\`\`\`\n${serverErrors.join("\n")}\n\`\`\`\n`
      : "No errors in the server log during the probe.\n",
  ].join("\n");

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${label}.md`);
  writeFileSync(outFile, md);
  console.log(`\nWrote ${outFile}`);
}

async function cleanup() {
  await stopServer();
  await proxy?.close();
  proxy = null;
}

process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(130));
});

main()
  .then(cleanup)
  .catch(async (err) => {
    console.error(err);
    await cleanup();
    process.exit(1);
  });
