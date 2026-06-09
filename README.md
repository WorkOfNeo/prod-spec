# Prod Spec

Internal web app for Contrast Company that turns Monday.com order data into print-ready PDFs (washcare, barcode sticker, carton marking, colour sticker) and deposits them to SharePoint.

**Status:** M1–M4 implemented. M5 stabilisation in progress. Pending real Monday column-mapping + Azure credentials to run end-to-end against Netto Germany.

---

## Stack

- Next.js 16 (app router, `proxy.ts` not `middleware.ts`)
- PostgreSQL on Railway, Prisma 7 (client output in `src/generated/prisma`)
- Better-Auth (email + password, allowlist-gated signup, ADMIN/REVIEWER roles)
- Microsoft Graph (SharePoint read/write) via `@azure/identity` + `@microsoft/microsoft-graph-client`
- Monday GraphQL API + webhooks (append-only registry)
- Puppeteer (single shared browser) + bwip-js (EAN-13 server-side render)
- Resend for review notifications + supplier delivery emails

---

## Local setup

```bash
npm install

# Fill in .env — see .env.example. Required to boot:
#   DATABASE_URL, BETTER_AUTH_SECRET, SIGNUP_ALLOWLIST
# Required for end-to-end flow:
#   MONDAY_API_TOKEN, MONDAY_WEBHOOK_SECRET, JOB_RUNNER_SECRET,
#   AZURE_* + SHAREPOINT_SITE_ID, RESEND_API_KEY + EMAIL_FROM,
#   REVIEW_NOTIFICATION_EMAIL, PROD_SPEC_BASE_URL

npx prisma migrate dev --name init
npm run dev
```

`BETTER_AUTH_SECRET`, `MONDAY_WEBHOOK_SECRET`, and `JOB_RUNNER_SECRET` can be generated with `openssl rand -base64 32` / `openssl rand -hex 32`.

---

## Project layout

```
src/
├── app/
│   ├── (admin)/                       # auth-gated admin UI
│   │   ├── styles/                    # list + detail + review screens
│   │   ├── jobs/                      # run log + "Run pending jobs now"
│   │   └── settings/                  # customer config CRUD + webhook registry
│   ├── (auth)/                        # login + signup
│   └── api/
│       ├── auth/[...all]/             # Better-Auth handler
│       ├── webhooks/monday/           # Monday → us
│       ├── jobs/run/                  # runner (cron / inline / "run now")
│       └── admin/
│           ├── customers/             # CRUD (ADMIN)
│           ├── webhooks/              # bootstrap registry (ADMIN)
│           ├── jobs/[id]/             # approve / reject / preview
│           └── styles/[id]/rerun/     # manual re-run
├── lib/
│   ├── db.ts                          # Prisma singleton (@prisma/adapter-pg)
│   ├── auth.ts                        # Better-Auth config
│   ├── auth-server.ts                 # requireRole / getServerSession
│   ├── customers/config.ts            # CustomerConfig zod schema
│   ├── customers/resolve.ts           # board id → customer lookup
│   ├── monday/                        # client, webhook, ingest, completion
│   ├── sharepoint/                    # auth, client, upload
│   ├── pdf/                           # renderer, barcode, mapper, templates/*
│   ├── queue/                         # enqueue, runner, trigger
│   └── email/                         # Resend wrapper + templates
└── proxy.ts                           # auth redirects (Next.js 16 rename of middleware)
```

---

## End-to-end flow

1. Monday board emits a `change_column_value` or `create_item` event.
2. Monday POSTs to `/api/webhooks/monday?token=<MONDAY_WEBHOOK_SECRET>`.
3. Receiver verifies the token, fetches the item, resolves the customer by board id, runs the column-mapping → `StyleData`, computes completion %, upserts a `Style` row.
4. If completion is 100% and no in-flight job exists for the style, a `Job` is enqueued and `/api/jobs/run` is triggered inline.
5. Runner claims jobs with `FOR UPDATE SKIP LOCKED`, renders all enabled doc types via Puppeteer, stores PDF bytes on `JobAsset`, marks job `AWAITING_REVIEW`, emails `REVIEW_NOTIFICATION_EMAIL`.
6. Reviewer opens the link, previews PDFs inline at `/styles/[id]/review`, and clicks Approve or Reject.
7. **Approve** → SharePoint upload at the customer's `sharepointPath` + supplier email (with `[Correction]` prefix on re-runs).
8. **Reject** → reason logged, optional Monday status writeback.

---

## Operator playbook

### Column mapping is shared across all customers

The same Monday columns are synced for every customer, so the column mapping + required fields live in **one global row**, not per-customer. Edit them under `/settings` → **Register & fill →** (`/settings/monday`) → **Shared column mapping**:

- `columnMapping` — each field → a Monday column id.
- `requiredFields` — the column ids that must be filled for a style to be ready.

Per-customer config (`Customer.config`) now only carries `mondayBoardIds`, `enabledDocTypes`, and `sharepointPath`. (Legacy customer configs that still contain `columnMapping` / `requiredFields` keys parse fine — those keys are ignored.)

### Onboarding a new customer (the M4 promise)

No code changes — config only.

1. Sign in as ADMIN.
2. Go to `/settings` → **+ Add customer**.
3. Set the slug (kebab-case, permanent), name, supplier email, SharePoint folder path.
4. List the customer's Monday board IDs under `mondayBoardIds` so the webhook receiver routes events to this customer.
5. Save.
6. The shared column mapping already applies — no per-customer mapping needed.
7. From `/settings` → **Register & fill →** (`/settings/monday`): **Check columns** to confirm the shared mapping resolves against this board, **Register webhooks**, then **Fill now** for the one-time backfill.

### Registering Monday webhooks

**UI (recommended):** `/settings` → **Register & fill →** (or go straight to `/settings/monday`). Per board you can:

1. **Check columns** — confirms every column id in the customer's `columnMapping` / `requiredFields` actually exists on the live Monday board before you flip webhooks on. (Wiki scar: a stale column id silently resolves to nothing and produces empty mirror fields with no error.)
2. **Register webhooks** — defaults to `create_item`, `change_column_value`, `change_status_column_value`, `item_archived`, `item_deleted`. Append-only: only events not already in our registry are created.
3. **Fill now** — one-time backfill of every existing item on the board into the `Style` mirror. **Mirror-only**: it does *not* enqueue jobs or email reviewers. After the fill, incoming webhooks keep the mirror current and drive the pipe.

**API equivalent** — append-only, code never deletes:

```bash
curl -X POST $PROD_SPEC_BASE_URL/api/admin/webhooks \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie-from-sign-in>" \
  -d '{"boardId": "1234567890", "events": ["create_item", "change_column_value", "change_status_column_value", "item_archived", "item_deleted"]}'

# Column readiness:
curl "$PROD_SPEC_BASE_URL/api/admin/monday/columns?boardId=1234567890" -H "Cookie: <session>"
# One-time mirror backfill:
curl -X POST $PROD_SPEC_BASE_URL/api/admin/monday/sync \
  -H "Content-Type: application/json" -H "Cookie: <session>" -d '{"boardId": "1234567890"}'
```

Register response: `{created, skipped, foreign}` — the `foreign` array surfaces webhooks that exist on Monday but not in our DB (created via the Monday UI). We never touch them.

**Archive / delete** never hard-delete a mirror row. An `item_archived` / `item_deleted` webhook stamps `archivedAt` / `deletedAt` on the `Style` so it drops out of the UI lists while the row and its full `Log` trail survive for audit. A later edit to the item clears the flag and it reappears.

### Triggering a re-run

- **UI**: open `/styles/[id]` → **Re-run**.
- **API**: `POST /api/admin/styles/[id]/rerun` with a signed-in cookie.

Re-runs overwrite the previous SharePoint files and, on approval, send a supplier email with `[Correction]` prefix.

### Running pending jobs manually

The runner fires automatically after a webhook brings a style to 100% completion. To process queued jobs out-of-band:

- **UI**: `/jobs` → **Run pending jobs now**.
- **Cron**: `curl -X POST $PROD_SPEC_BASE_URL/api/jobs/run?secret=$JOB_RUNNER_SECRET`. Recommended cadence: every minute on Railway cron, as a safety net for the inline trigger.

### Reading the logs

- `/jobs` shows recent job runs (top) and the last 100 log entries (bottom).
- Each `Log` row has a level (DEBUG/INFO/WARN/ERROR) and a free-text message. Failed jobs include an error tag like `[MAPPING_FAILED]`, `[RENDER_FAILED]`, `[BARCODE_FAILED]`, `[PERSIST_FAILED]`, `[CONFIG_INVALID]`.
- `npx prisma studio` for ad-hoc inspection of `Job`, `JobAsset`, `Log`, `ReviewAction`.

### Roles

- **ADMIN**: customer config, webhook bootstrap, all reviewer actions. First user to sign up is auto-promoted to ADMIN.
- **REVIEWER**: read customers, view styles + jobs, approve/reject, re-run, run pending jobs.

To promote a user, update the `users.role` column directly in Prisma Studio or with `npx prisma db execute`.

### Adjusting a template

Templates live under `src/lib/pdf/templates/`. Each consumes the canonical `StyleData` shape from `src/lib/pdf/types.ts`. Per-customer toggles belong in `Customer.config` so the template stays generic; raw layout/styling tweaks go in the template file itself.

---

## Phase 1 blockers (real-data unblockers)

Items needed to run the full loop against a real Netto Germany order. The code paths exist; these inputs fill them in:

- **Monday column mapping** — paste into the Netto Germany customer config (`columnMapping`).
- **Barcode source decision** — Monday sub-items (Option A) vs PO PDF (Option B). Drives the `parseSizes` logic in `src/lib/pdf/mapper.ts`.
- **Azure app registration** — `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and the SharePoint site id from Contrast IT.
- **SharePoint folder structure** — put the target folder path in the customer's `sharepointPath` field.
- **Print spec** — DPI, colour profile, bleed sign-off. Puppeteer outputs RGB. If supplier requires CMYK, swap renderer before going live.
- **Wash-care symbol set** — current implementation uses Unicode placeholders. Replace with the GINETEX/ISO 3758 SVG set when available.

The full kickoff plan with milestone breakdown lives at `/Users/niels/.claude/plans/prod-spec-zesty-flurry.md`.

---

## Deployment notes

- **Railway**: deploy `main` to a single service. Postgres comes from a Railway Postgres add-on. Internal URL (`*.railway.internal`) for `DATABASE_URL`; public proxy URL with `?sslmode=require` only needed for local migrations.
- **Set every env var from `.env.example`** in Railway before first boot. Missing `BETTER_AUTH_SECRET` will throw immediately.
- **Puppeteer on Railway**: the default `puppeteer` package downloads Chromium at install time. If image build is too slow, switch to `puppeteer-core` + a base image with Chromium preinstalled.
- **Job runner schedule**: add a Railway cron hitting `POST /api/jobs/run?secret=$JOB_RUNNER_SECRET` every minute. Inline triggering covers the happy path; cron handles missed runs.
