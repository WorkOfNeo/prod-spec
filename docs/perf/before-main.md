# Perf probe — before-main

- Checkout: `/home/user/prod-spec/.claude/worktrees/agent-ac740c10e6babedda` — worktree-agent-ac740c10e6babedda @ dfa20a4
- Probed: 2026-10-12T11:04:26.584Z on vm (4 CPUs), Node v22.22.0
- Database: `prodspec_p0` — 5000 styles (rawData avg 12.1 KB), 7846 jobs, 31871 job assets, 80 styles awaiting review, 3000 ghost items
- Style detail target: `/styles/perf-sty-01188` (in-flow style with the longest job history)
- Method: one warm-up request per URL, then 5 sequential requests (curl, no compression) for TTFB / total / KB; one more with `Accept-Encoding: gzip` for KB gzip; one more after a database-scoped `pg_stat_statements_reset` for DB queries (sum of calls, utility statements such as BEGIN included), rows returned and server-side execution time. Times in ms.
- Build: `npm run build` took 78 s

### Latency 0 ms (proxy pass-through)

Host load average (1 min) 2.3 → 2.0 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 398 | 361 | 533 | 404 | 366 | 538 | 190 | 33 | 894 | 3079 | 51 |
| `/styles` | 200 | 4926 | 4902 | 5267 | 5139 | 5120 | 5497 | 21244 | 1359 | 21 | 91629 | 712 |
| `/styles/<style>` | 200 | 79 | 62 | 99 | 82 | 64 | 102 | 132 | 26 | 47 | 304 | 17 |
| `/reviews/dashboard` | 200 | 483 | 469 | 569 | 486 | 471 | 571 | 150 | 24 | 15 | 71053 | 128 |
| `/api/admin/dashboard/counts` | 200 | 36 | 32 | 43 | 36 | 32 | 44 | 0.1 | 0.1 | 10 | 706 | 16 |
| `/api/admin/import/counts` | 200 | 300 | 291 | 343 | 300 | 291 | 343 | 0.1 | 0.1 | 11 | 4985 | 273 |

### Latency 2 ms per chunk each way (≈4 ms added per query round trip)

Host load average (1 min) 2.0 → 2.0 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 674 | 636 | 775 | 678 | 639 | 778 | 190 | 33 | 894 | 3079 | 55 |
| `/styles` | 200 | 4917 | 4733 | 5254 | 5134 | 4956 | 5484 | 21244 | 1359 | 22 | 91659 | 711 |
| `/styles/<style>` | 200 | 183 | 173 | 203 | 185 | 175 | 206 | 132 | 26 | 47 | 304 | 23 |
| `/reviews/dashboard` | 200 | 514 | 490 | 590 | 518 | 492 | 593 | 150 | 24 | 15 | 71053 | 103 |
| `/api/admin/dashboard/counts` | 200 | 66 | 63 | 74 | 66 | 64 | 74 | 0.1 | 0.1 | 10 | 706 | 18 |
| `/api/admin/import/counts` | 200 | 324 | 293 | 434 | 324 | 293 | 435 | 0.1 | 0.1 | 11 | 4985 | 238 |

No errors in the server log during the probe.
