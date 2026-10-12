# Perf probe — baseline-main

- Checkout: `/home/user/prod-spec/.claude/worktrees/agent-ac740c10e6babedda` — worktree-agent-ac740c10e6babedda @ 4e5f654
- Probed: 2026-10-12T10:14:01.415Z on vm (4 CPUs), Node v22.22.0
- Database: `prodspec_p0` — 5000 styles (rawData avg 12.1 KB), 7846 jobs, 31871 job assets, 80 styles awaiting review, 3000 ghost items
- Style detail target: `/styles/perf-sty-01188` (in-flow style with the longest job history)
- Method: one warm-up request per URL, then 5 sequential requests (curl, no compression) for TTFB / total / KB; one more with `Accept-Encoding: gzip` for KB gzip; one more after a database-scoped `pg_stat_statements_reset` for DB queries (sum of calls, utility statements such as BEGIN included), rows returned and server-side execution time. Times in ms.
- Build: `npm run build` took 116 s

### Latency 0 ms (proxy pass-through)

Host load average (1 min) 5.6 → 4.0 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 578 | 448 | 695 | 582 | 451 | 700 | 190 | 33 | 894 | 3079 | 66 |
| `/styles` | 200 | 5599 | 5575 | 5790 | 5845 | 5806 | 5978 | 21244 | 1359 | 21 | 91629 | 984 |
| `/styles/<style>` | 200 | 82 | 81 | 98 | 86 | 84 | 101 | 132 | 26 | 47 | 304 | 14 |
| `/reviews/dashboard` | 200 | 504 | 457 | 653 | 507 | 461 | 658 | 150 | 24 | 15 | 71053 | 143 |
| `/api/admin/dashboard/counts` | 200 | 57 | 36 | 83 | 57 | 37 | 84 | 0.1 | 0.1 | 10 | 706 | 15 |
| `/api/admin/import/counts` | 200 | 321 | 283 | 428 | 322 | 283 | 428 | 0.1 | 0.1 | 11 | 4985 | 366 |

#### Statements per request (latency 0 ms)

<details><summary><code>/dashboard</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 80 | 80 | 15.2 | `SELECT "public"."styles"."id", "public"."styles"."rawData", "public"."styles"."poNumber", "public"."styles"."cartonEan", "public"."styles"."supplierId", "public"."styles"."customerId", "public"."styles"."prodSpecId" F…` |
| 80 | 621 | 9.3 | `SELECT "public"."job_assets"."id", "public"."job_assets"."jobId", "public"."job_assets"."variantKey", "public"."job_assets"."docType", "public"."job_assets"."fileName", "public"."job_assets"."displayName", "public"."j…` |
| 80 | 80 | 3.2 | `SELECT "public"."customers"."id", "public"."customers"."config" FROM "public"."customers" WHERE "public"."customers"."id" = $1 OFFSET $2` |
| 80 | 451 | 2.5 | `SELECT "public"."style_eans"."id", "public"."style_eans"."size", "public"."style_eans"."ean13", "public"."style_eans"."cartonEan", "public"."style_eans"."styleId" FROM "public"."style_eans" WHERE "public"."style_eans"…` |
| 80 | 480 | 2.3 | `SELECT "public"."doc_types"."value", "public"."doc_types"."label" FROM "public"."doc_types" WHERE $2=$3 ORDER BY "public"."doc_types"."sortOrder" ASC, "public"."doc_types"."label" ASC OFFSET $1` |
| 80 | 0 | 1.9 | `SELECT "public"."jobs"."id", "public"."jobs"."variantKeys" FROM "public"."jobs" WHERE ("public"."jobs"."styleId" = $1 AND "public"."jobs"."status" IN (CAST($2::text AS "public"."JobStatus"),CAST($3::text AS "public"."…` |

</details>

<details><summary><code>/styles</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 2 | 2 | 0.1 | `SELECT "public"."users"."id", "public"."users"."email", "public"."users"."emailVerified", "public"."users"."name", "public"."users"."image", "public"."users"."role"::text, "public"."users"."createdAt", "public"."users…` |
| 2 | 2 | 0.0 | `SELECT "public"."users"."id", "public"."users"."role"::text FROM "public"."users" WHERE ("public"."users"."id" = $1 AND $4=$5) LIMIT $2 OFFSET $3` |
| 1 | 4255 | 795.7 | `SELECT "public"."styles"."id", "public"."styles"."customerId", "public"."styles"."businessAreaId", "public"."styles"."supplierId", "public"."styles"."prodSpecId", "public"."styles"."qrImageId", "public"."styles"."mond…` |
| 1 | 27814 | 65.0 | `SELECT "public"."job_assets"."id", "public"."job_assets"."jobId", "public"."job_assets"."variantKey", "public"."job_assets"."docType", "public"."job_assets"."reviewStatus"::text, "public"."job_assets"."placeholderCoun…` |
| 1 | 21737 | 37.7 | `SELECT "public"."style_eans"."id", "public"."style_eans"."size", "public"."style_eans"."ean13", "public"."style_eans"."cartonEan", "public"."style_eans"."styleId" FROM "public"."style_eans" WHERE "public"."style_eans"…` |
| 1 | 7048 | 22.8 | `SELECT "public"."jobs"."id", "public"."jobs"."styleId" FROM "public"."jobs" WHERE ("public"."jobs"."status" <> CAST($1::text AS "public"."JobStatus") AND EXISTS(SELECT "t0"."jobId" FROM "public"."job_assets" AS "t0" W…` |

</details>

<details><summary><code>/styles/&lt;style&gt;</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 2 | 2 | 0.2 | `SELECT "public"."customers"."id", "public"."customers"."config" FROM "public"."customers" WHERE "public"."customers"."id" = $1 OFFSET $2` |
| 2 | 12 | 0.1 | `SELECT "public"."doc_types"."value", "public"."doc_types"."label" FROM "public"."doc_types" WHERE $2=$3 ORDER BY "public"."doc_types"."sortOrder" ASC, "public"."doc_types"."label" ASC OFFSET $1` |
| 2 | 2 | 0.0 | `SELECT "public"."styles"."id", "public"."styles"."useStyleBoardColour" FROM "public"."styles" WHERE ("public"."styles"."id" = $1 AND $4=$5) LIMIT $2 OFFSET $3` |
| 2 | 2 | 0.0 | `SELECT "public"."business_areas"."id", "public"."business_areas"."mondayValue", "public"."business_areas"."name", "public"."business_areas"."active", "public"."business_areas"."lastSyncedAt", "public"."business_areas"…` |
| 2 | 2 | 0.0 | `SELECT "public"."users"."id", "public"."users"."email", "public"."users"."emailVerified", "public"."users"."name", "public"."users"."image", "public"."users"."role"::text, "public"."users"."createdAt", "public"."users…` |
| 2 | 0 | 0.0 | `SELECT "public"."style_output_ignores"."id", "public"."style_output_ignores"."variantKey" FROM "public"."style_output_ignores" WHERE "public"."style_output_ignores"."styleId" = $1 OFFSET $2` |

</details>

<details><summary><code>/reviews/dashboard</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 2 | 2 | 0.1 | `SELECT "public"."users"."id", "public"."users"."email", "public"."users"."emailVerified", "public"."users"."name", "public"."users"."image", "public"."users"."role"::text, "public"."users"."createdAt", "public"."users…` |
| 2 | 2 | 0.0 | `SELECT "public"."users"."id", "public"."users"."role"::text FROM "public"."users" WHERE ("public"."users"."id" = $1 AND $4=$5) LIMIT $2 OFFSET $3` |
| 1 | 27617 | 78.8 | `SELECT "public"."job_assets"."id", "public"."job_assets"."jobId", "public"."job_assets"."variantKey", "public"."job_assets"."docType", "public"."job_assets"."reviewStatus"::text, "public"."job_assets"."createdAt", "pu…` |
| 1 | 6790 | 23.8 | `SELECT "public"."jobs"."id", "public"."jobs"."styleId", "public"."jobs"."status"::text, "public"."jobs"."createdAt" FROM "public"."jobs" LEFT JOIN "public"."styles" AS "j0" ON ("j0"."id") = ("public"."jobs"."styleId")…` |
| 1 | 31456 | 23.4 | `SELECT "public"."job_assets"."id", "public"."job_assets"."reviewedById" FROM "public"."job_assets" WHERE "public"."job_assets"."reviewedById" IS NOT NULL OFFSET $1` |
| 1 | 4096 | 12.1 | `SELECT "public"."styles"."id", "public"."styles"."name", "public"."styles"."poNumber", "public"."styles"."customerId", "public"."styles"."supplierId" FROM "public"."styles" WHERE ("public"."styles"."archivedAt" IS NUL…` |

</details>

<details><summary><code>/api/admin/dashboard/counts</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 1 | 80 | 12.6 | `SELECT "public"."styles"."id", "public"."styles"."customerId", "public"."styles"."businessAreaId", "public"."styles"."supplierId", "public"."styles"."prodSpecId", "public"."styles"."qrImageId", "public"."styles"."mond…` |
| 1 | 453 | 0.9 | `SELECT "public"."job_assets"."id", "public"."job_assets"."variantKey", "public"."job_assets"."docType", "public"."job_assets"."displayName", "public"."job_assets"."reviewStatus"::text, "public"."job_assets"."reviewedB…` |
| 1 | 93 | 0.6 | `SELECT "public"."jobs"."id", "public"."jobs"."styleId", "public"."jobs"."prodSpecId", "public"."jobs"."status"::text, "public"."jobs"."triggerSource"::text, "public"."jobs"."documentTypes", "public"."jobs"."variantKey…` |
| 1 | 39 | 0.4 | `SELECT "public"."prod_specs"."id", "public"."prod_specs"."name", "public"."prod_specs"."outputs" FROM "public"."prod_specs" WHERE "public"."prod_specs"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$…` |
| 1 | 29 | 0.2 | `SELECT "public"."customers"."id", "public"."customers"."slug", "public"."customers"."mondayItemId", "public"."customers"."name", "public"."customers"."priority", "public"."customers"."salesResponsible", "public"."cust…` |
| 1 | 6 | 0.1 | `SELECT "public"."business_areas"."id", "public"."business_areas"."mondayValue", "public"."business_areas"."name", "public"."business_areas"."active", "public"."business_areas"."lastSyncedAt", "public"."business_areas"…` |

</details>

<details><summary><code>/api/admin/import/counts</code> — top 6 statements by calls</summary>

| calls | rows | exec ms | statement |
|--:|--:|--:|---|
| 1 | 3000 | 360.2 | `SELECT i.id, i."mondayItemId" AS monday_item_id, i.name, i."groupTitle" AS group_title, ba_cv.text AS ba_text, link_cv.value AS customer_link_value, po_cv.text AS po_text FROM monday_ghost_items i LEFT JOIN LATERAL ( …` |
| 1 | 4 | 3.0 | `SELECT "public"."prod_specs"."id", "public"."prod_specs"."customerId", "public"."prod_specs"."businessAreaId", "public"."prod_specs"."name", "public"."prod_specs"."outputs", "public"."prod_specs"."logoSvg", "public"."…` |
| 1 | 1860 | 2.6 | `SELECT "public"."styles"."id", "public"."styles"."mondayItemId" FROM "public"."styles" WHERE "public"."styles"."mondayItemId" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,…` |
| 1 | 40 | 0.1 | `SELECT "public"."customers"."id", "public"."customers"."name", "public"."customers"."mondayItemId" FROM "public"."customers" WHERE "public"."customers"."active" = $1 ORDER BY "public"."customers"."name" ASC OFFSET $2` |
| 1 | 61 | 0.1 | `SELECT "public"."prod_specs"."id", "public"."prod_specs"."customerId", "public"."prod_specs"."businessAreaId" FROM "public"."prod_specs" WHERE $2=$3 OFFSET $1` |
| 1 | 4 | 0.0 | `SELECT "public"."customers"."id", "public"."customers"."name" FROM "public"."customers" WHERE "public"."customers"."id" IN ($1,$2,$3,$4) OFFSET $5` |

</details>

### Latency 2 ms per chunk each way (≈4 ms added per query round trip)

Host load average (1 min) 4.0 → 3.6 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 688 | 643 | 829 | 693 | 648 | 834 | 190 | 33 | 894 | 3079 | 57 |
| `/styles` | 200 | 5289 | 4857 | 5651 | 5512 | 5111 | 5843 | 21244 | 1359 | 22 | 91659 | 789 |
| `/styles/<style>` | 200 | 197 | 184 | 206 | 201 | 186 | 210 | 132 | 26 | 47 | 304 | 18 |
| `/reviews/dashboard` | 200 | 461 | 440 | 553 | 466 | 442 | 556 | 150 | 24 | 15 | 71053 | 146 |
| `/api/admin/dashboard/counts` | 200 | 69 | 59 | 78 | 70 | 59 | 78 | 0.1 | 0.1 | 10 | 706 | 15 |
| `/api/admin/import/counts` | 200 | 321 | 310 | 373 | 321 | 311 | 374 | 0.1 | 0.1 | 11 | 4985 | 396 |

No errors in the server log during the probe.

## Observations (added by hand, not generated)

App code here is identical to `main` @ 468194a; this branch only adds `scripts/perf/`, `docs/perf/` and the `perf:*` npm scripts.

- **`/styles` is the outlier: ~5.5–5.8 s, and TTFB ≈ total, so nothing streams.** The page loads 4,255 styles (the active set plus the PO-less rows) and sends **21 MB of HTML** (1.36 MB gzipped). The main `styles` query takes ~0.8 s inside Postgres because it reads every full row (`rawData`, `poScrapeSnapshot`, …) and returns ~92k rows across its 21 statements. The other ~4.5 s is server CPU: per-row readiness and notice computation, then serialising ~5 KB of props per row.
- **`/dashboard` issues 894 statements per request.** `getCurrentOutputsForStyle` runs once per awaiting style (80), and each call costs ~11 statements (style + rawData, assets, EANs, customer, prod spec, supplier, doc types, in-flight jobs, ignores, field values, …). The 80 calls run concurrently through the 10-connection pool, so locally the work overlaps and +2 ms only adds ~110 ms. In production every one of those round trips pays the real network hop. The awaiting-review query also pulls the full style row, including `rawData`, for the 80 styles behind the 93 awaiting jobs.
- **`/api/admin/dashboard/counts`** (polled every 60 s per open tab) runs that same full-row awaiting-review query only to count buckets.
- **`/api/admin/import/counts`** (the bell, polled every 60 s) is DB-bound. One LATERAL `jsonb_array_elements` scan over the 3,000 ghost items costs ~0.36–0.40 s of DB time per request, which is essentially the whole request.
- **`/reviews/dashboard`** reads ~71k rows: every job and asset of the active set, plus a scan of every asset's `reviewedById` for the reviewer picker.
- **`/styles/<id>`** is fast locally (~85 ms) but the most latency-sensitive page here: 47 statements, roughly 24 of them sequential, so +2 ms per chunk adds ~115 ms.
- No page errored with this data. The server log was clean.
- Host load was 3.6–5.6 on 4 CPUs (other agents' builds and tests), so expect ±20% run-to-run noise on the times. The query and row counts are exact.
