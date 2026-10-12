# Perf probe — after-speed

- Checkout: `/home/user/prod-spec` — claude/serene-brown-a18jx0 @ 914304b
- Probed: 2026-10-12T11:07:50.669Z on vm (4 CPUs), Node v22.22.0
- Database: `prodspec_p0` — 5000 styles (rawData avg 12.1 KB), 7846 jobs, 31871 job assets, 80 styles awaiting review, 3000 ghost items
- Style detail target: `/styles/perf-sty-01188` (in-flow style with the longest job history)
- Method: one warm-up request per URL, then 5 sequential requests (curl, no compression) for TTFB / total / KB; one more with `Accept-Encoding: gzip` for KB gzip; one more after a database-scoped `pg_stat_statements_reset` for DB queries (sum of calls, utility statements such as BEGIN included), rows returned and server-side execution time. Times in ms.
- Build: `npm run build` took 70 s

### Latency 0 ms (proxy pass-through)

Host load average (1 min) 1.8 → 2.1 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 70 | 57 | 78 | 75 | 61 | 83 | 190 | 33 | 23 | 1024 | 30 |
| `/styles` | 200 | 1954 | 1839 | 2361 | 2063 | 1916 | 2464 | 6709 | 492 | 23 | 92350 | 1527 |
| `/styles/<style>` | 200 | 75 | 60 | 88 | 77 | 64 | 93 | 132 | 26 | 41 | 298 | 12 |
| `/reviews/dashboard` | 200 | 468 | 442 | 480 | 472 | 444 | 483 | 150 | 24 | 12 | 71050 | 111 |
| `/api/admin/dashboard/counts` | 200 | 14 | 11 | 16 | 14 | 11 | 17 | 0.1 | 0.1 | 3 | 547 | 1 |
| `/api/admin/import/counts` | 200 | 7 | 7 | 8 | 7 | 7 | 8 | 0.1 | 0.1 | 1 | 1 | 0 |

### Latency 2 ms per chunk each way (≈4 ms added per query round trip)

Host load average (1 min) 2.1 → 1.8 on 4 CPUs.

| URL | HTTP | TTFB med | TTFB min | TTFB max | Total med | Total min | Total max | KB | KB gzip | DB queries | DB rows | DB exec ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/dashboard` | 200 | 68 | 65 | 71 | 71 | 68 | 74 | 190 | 33 | 23 | 1024 | 6 |
| `/styles` | 200 | 1847 | 1808 | 2172 | 1997 | 1900 | 2301 | 6709 | 492 | 23 | 92350 | 1713 |
| `/styles/<style>` | 200 | 85 | 82 | 108 | 88 | 84 | 116 | 132 | 26 | 41 | 298 | 13 |
| `/reviews/dashboard` | 200 | 436 | 405 | 527 | 439 | 407 | 530 | 150 | 24 | 12 | 71050 | 104 |
| `/api/admin/dashboard/counts` | 200 | 25 | 23 | 27 | 26 | 23 | 28 | 0.1 | 0.1 | 3 | 547 | 1 |
| `/api/admin/import/counts` | 200 | 10 | 9 | 11 | 10 | 10 | 11 | 0.1 | 0.1 | 1 | 1 | 0 |

No errors in the server log during the probe.
