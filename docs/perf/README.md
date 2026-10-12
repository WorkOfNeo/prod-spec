# Perf harness

A local, repeatable way to measure the slow pages (Dashboard, Styles list, style
detail, review dashboard and the two sidebar pollers) before and after a change.

| File | What it does |
|---|---|
| `scripts/perf/seed.ts` | Fills a local database with production-shaped, deterministic data |
| `scripts/perf/seed-monday.ts` | Builds the Pre-Order Monday items behind `Style.rawData` and the ghost mirror |
| `scripts/perf/probe.ts` | Builds a checkout, starts it, times the pages, counts DB queries, writes `docs/perf/<label>.md` |
| `scripts/perf/latency-proxy.ts` | TCP proxy that adds a per-chunk delay between the app and Postgres |
| `docs/perf/baseline-main.md` | The numbers for `main` @ 468194a |

Run the harness from a checkout that contains `scripts/perf/` (this branch, or
`main` once it is merged). The checkout being *probed* can be any branch.

## Requirements

- Postgres 16 with `pg_stat_statements` in `shared_preload_libraries` (the probe
  runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` in the target DB).
- A migrated database of your own, e.g. `postgresql://postgres@localhost:5432/prodspec_p0`.
- The harness checkout and the probed checkout each need `node_modules` and a
  generated Prisma client. Nothing here installs packages. In a fresh worktree:

  ```sh
  cp -al /home/user/prod-spec/node_modules ./node_modules   # hard-link, no npm install
  npx prisma generate
  ```

- `curl` on the PATH.

`DATABASE_URL` is always passed explicitly. The `perf:*` scripts don't use
`--env-file=.env` on purpose: `.env` can point at production, and the seed
truncates tables.

## Seed

```sh
DATABASE_URL=postgresql://postgres@localhost:5432/prodspec_p0 npx tsx scripts/perf/seed.ts
# or: DATABASE_URL=… npm run perf:seed -- --styles 5000
```

Options: `--styles N` (default 5000; everything sized per style scales with
it), `--seed S` (PRNG seed, default 20261012), `--now <iso>` (anchor for every
timestamp, default the moment it runs), `--force` (allow a non-localhost
`DATABASE_URL`, which is refused by default). It takes about 80 s for 5,000 styles.

It truncates every table it fills, keeps the `perf-admin` user (or creates it
as the oldest and only ADMIN, which `AUTH_DISABLED` runs as), and keeps the
migration-seeded `doc_types` / `trim_concept_rows`. Every entity draws from its
own PRNG stream, so the same flags give identical rows. Two runs with the same
`--now` produce byte-identical tables.

What a default run produces:

| Data | Volume | Notes |
|---|---|---|
| Customers / business areas | 40 / 10 (+ the "PL" alias) | Real customer names. Five JYSK, four Netto and three COOP entities share a leading token, so the import scan's ambiguous bucket is real |
| Prod specs | 61 (4 unconfigured) | 3–8 outputs each. They mix the customer's coded print specs from the template registry with Output Builder `layout:<id>` keys. All are validated with `ProdSpecOutputsSchema` |
| Output Builder layouts | 36 (30 published) | Validated with `parseLayoutDef`. Two repeat per size, which gives `layout:<id>#<size>` assets |
| Styles | 5,000 | Avg `rawData` ≈ 12 KB (≈ 4.5 KB TOASTed). About 3.9k are in the active set. Included: ~16% Done group (a slice re-admitted by `doneGroupPoCutoff`), ~4% without a PO, ~2% archived, Cancelled/Templates rows, ~4% lookalike names on other POs, ~30% missing 1–3 mapped Monday fields, and ~50% of scraped styles carry a `poScrapeSnapshot` |
| `Style.rawData` | 68 column values + `__name__` | The Pre-Order item exactly as `ingestMondayItem` stores it: `value` is a JSON string, board relations have `linked_item_ids`/`display_value`, mirrors have `display_value`, and cells carry `changed_at` stamps |
| Style EANs | ~25.6k | 5–8 per style for every resolved/partial EAN status |
| Jobs / job assets | ~7.8k / ~31.9k | Full runs carry a cover (and sometimes general info). Per-output reruns spread a style's documents across several jobs. `pdf` is a 192-byte PDF |
| Review queue | 80 styles whose newest job is `AWAITING_REVIEW` | 10 claimed or partly decided by `perf-admin`, 10 by `perf-reviewer`, 60 untouched. About a third are reruns, and some also have an older stranded awaiting job |
| Review trail | ~7k review actions, ~1k rejection tickets, ~14k user notifications | REVIEW_READY for the admin and the reviewer, resolved when the job settles |
| Delivery | ~23k supplier-send queue rows, ~3.4k supplier shares | One queue row per currently approved (style × output) |
| Monday ghosts | 3,000 Pre-Order items + 68 columns + options | 62% are already promoted. The rest are spread over the scan's buckets: importable, ambiguous, unmatched, blank/unknown BA, new combo, archived |
| Catalogues | Languages, countries, wash symbols, certificates, care labels, info-area sizes, QR images, 380 translations | |
| App settings | auto-generate on, `doneGroupPoCutoff`, PO cutoffs, `stylesTableColumns` | The admin's /styles view is the standard columns plus supplier, prod spec, SharePoint upload, approved, awaiting review and reviewer, so the batched rollup queries run |

Users: `perf-admin` (ADMIN), plus `perf-reviewer`, `perf-reviewer-2` and
`perf-reviewer-3` (REVIEWER).

## Probe

```sh
DATABASE_URL=postgresql://postgres@localhost:5432/prodspec_p0 \
  npx tsx scripts/perf/probe.ts <checkoutDir> <label> [--latency-ms 0,2]
```

For each run it:

1. Runs `npm run build` in `<checkoutDir>` with the direct `DATABASE_URL`. Use
   `--skip-build` to reuse an existing `.next`.
2. Starts the latency proxy on `--proxy-port` (3111), then `next start -p 3101`
   in the checkout. The app gets `AUTH_DISABLED=true`,
   `REVIEW_FOLLOW_THROUGH_DISABLED=false` (otherwise `/dashboard` redirects) and
   a `DATABASE_URL` that goes through the proxy.
3. For each latency in `--latency-ms` (default `0,2`) and each URL, it sends one
   warm-up request, then `--runs` (5) sequential `curl` requests. These record
   TTFB, total time and bytes (uncompressed). One more request with
   `Accept-Encoding: gzip` records the wire size. One more request, after a
   database-scoped `pg_stat_statements_reset`, records the query count, rows
   returned and server-side execution time.
4. Prints a markdown table per latency and writes `docs/perf/<label>.md`. Any
   error lines from the server log are included.
5. Kills the server's process group (only the processes it started) and closes
   the proxy.

URLs: `/dashboard`, `/styles`, `/styles/<id>`, `/reviews/dashboard`,
`/api/admin/dashboard/counts`, `/api/admin/import/counts`. The style is picked
by SQL: the live style with a prod spec and the most jobs, then the most assets,
with ties broken by id. That is deterministic for a given seed. Add paths with
`--url /path` (repeatable).

Other options: `--runs N`, `--port`, `--proxy-port`, `--out <dir>`, and
`--top N`. `--top N` adds a collapsible "statements per request" section with
each URL's N most frequent statements, which is the quickest way to spot an N+1.

### Latency

Localhost has no network hop, so an N+1 pattern costs almost nothing locally
and a lot in production. `--latency-ms 2` delays every chunk 2 ms in each
direction. That adds about 4–5 ms per query round trip (measured: 0.3 → 5.2 ms
for `SELECT 1`). It stands in for a private-network hop to the database; it is
not a measurement of Railway. Chunks that leave together arrive together, so a
pipelined Parse/Bind/Execute pays one delay, not three. `0` still goes through
the proxy, as a pass-through, so the delay is the only thing that changes
between the two tables.

### Reading the numbers

- **DB queries / DB rows** come straight from `pg_stat_statements` and don't
  depend on host load. They are the most reliable before/after signal. Utility
  statements such as `BEGIN` are included. If another client resets
  `pg_stat_statements` globally during a measurement, the probe detects it (via
  `pg_stat_statements_info`) and measures again; after 5 failed tries the cell
  reads `n/a`.
- **Times are wall-clock times on a shared box.** Other worktrees' builds,
  tests and servers compete for the same CPUs. Each section records the 1-minute
  load average. Compare runs made back to back under similar load. Prefer the
  min column when the load is high, and re-run when in doubt.
- **TTFB ≈ total** means the page renders everything before it sends the first
  byte (no streaming).
- **KB** is the uncompressed HTML/JSON. **KB gzip** is what a browser downloads.

## Probing another branch

```sh
git worktree add ../perf-target some-branch
cd ../perf-target && cp -al /home/user/prod-spec/node_modules ./node_modules && npx prisma generate && cd -
DATABASE_URL=postgresql://postgres@localhost:5432/prodspec_p0 \
  npx tsx scripts/perf/probe.ts ../perf-target after-some-branch
```

If the branch adds migrations (for example indexes), apply them to the perf
database first: `DATABASE_URL=… npx prisma migrate deploy` from that checkout.
Index-only migrations don't need a re-seed. Re-seed after anything that changes
the shape of seeded tables, and re-probe `main` on the same database, so the
before and after numbers come from the same data.
