# Change requests: technical design

Status: **approved 2026-10-24** (gate "Approve the design before building"). Decisions in §9 settled as recommended.
UX reference: the clickable mockup (private artifact, linked on the Ledger design task).
This document is also the build brief for every agent working on the feature. Read it whole before touching code.

## 1. What we are building

A person reports that a print output is wrong (text + screenshots, per output). An agent reads it, finds the data and the layout, drafts a layout change **on a copy**, renders before/after proofs, works out exactly which documents would change, and hands it to an admin. The admin can chat to get revisions, then approves. Approval publishes a new layout version and reruns exactly the changed documents through the normal review flow. If the change needs a value no token can express, the agent stops and hands a code spec to the developer instead of guessing.

Level 1 autonomy only: **a human approves every publish.**

## 2. Hard rails (non-negotiable, every module)

1. No agent step publishes, reruns, deletes, sends email to suppliers, touches SharePoint or manages webhooks. Agents only read and create drafts.
2. A draft never changes what prints. Only `publishRevision()` writes `OutputLayout.definition`, and only from an admin-initiated route.
3. Reruns started by a change request never re-arm supplier sends: no cover re-queue for the supplier digest (`enqueueCoverForSupplier(..., { notifySupplier: false })`, see §6.6) and approved documents are never rerun without an explicit second confirmation.
4. Everything ships behind `CHANGE_REQUESTS_ENABLED=true` (env, default off). With the flag off, no nav entry, pages 404, routes 404. Merging to main is therefore inert until the flag is set.
5. The repo is public: no live PO numbers, customer names from real requests, EANs or file names in code, fixtures, commits or PR text. Use synthetic fixtures.
6. Enum values: the only enum additions ship in their own migration, in the same PR as the code that writes them. All new status fields are `TEXT` validated in code, so later states need no enum migration.

## 3. Grounding: what exists today (verified 2026-10-24 at 9bd0a14)

- `OutputLayout` has ONE `definition` column and no history. The Output Builder autosaves (`PATCH /api/admin/output-layouts/[id]`, 1.2 s debounce) straight to the row; on a PUBLISHED layout that edit is live on the next render **and does not bump `version`**. `POST [id]/publish` validates and bumps `version` (in practice once, 0→1).
- Change detection: runner stamps `JobAsset.outputContentVersion = variant.contentVersion = OutputLayout.version`; `classifyOutput()` (`src/lib/outputs/rerun-buckets.ts`) only flags "changed" for pending outputs. Approved outputs are never "changed".
- Layout shape (`src/lib/output-layouts/schema.ts`): pages → grid (`gridCols × gridRows`, default cell ≈4 mm) → blocks with `rect {col,row,colSpan,rowSpan}`, `fontPt`, `bold`, `align`, `valign`, `fitWidth`, `lineHeight`, `border`, `lines: string[]`. Lines hold `{{token}}`, `{{token:arg}}`, single-level conditionals `{{if field op "value"}}…{{else}}…{{endif}}` (ops `== != contains !contains includes !includes`) and calcs `{{= expr }}`. `parseLayoutDef()` migrates legacy shapes and fills block ids; `LayoutDefSchema.parse` alone does not.
- Validation building blocks: `validateTokenRef`, `validateLineConditionals` (token-meta.ts), `validateLineCalcs` (calc.ts), all used by the publish route.
- Rendering: `renderLayoutHtml(def, style, opts)`; `loadStyleRenderContext(styleId)`; the faithful per-output render (pins via `applyFieldOverrides`, `applyCartonBarcodePrefs`, `effectiveOutputDims`, custom logo, layout images) lives only inside `GET/POST /api/admin/styles/[id]/output-preview`, through the variant registry, so it cannot render an unsaved definition. The builder preview route renders unsaved defs but skips pins/carton/dims.
- PDF: `renderPdf` (shared Puppeteer browser, fit-width pass). No HTML→PNG path exists; `renderPdfThumbnail` rasterises PDF page 1.
- AI: `src/lib/rejection-ai/ai-fix.ts` proposes line-text-only edits via `callClaudeForJson` (raw fetch, Haiku 4.5, text only). Prompts are editable through `SYSTEM_PROMPT_DEFS` (`src/lib/prompts/system-prompts.ts`).
- Reruns: `enqueueBulkRun({ runnable: {id, prodSpecId, variantKeys}[] , label, user })` creates scoped MANUAL_BULK jobs. **Scoped runs DO regenerate approved outputs** (durable approval is only enforced on full runs), so callers must pre-filter. The runner checks no in-flight jobs for bulk; callers must. **Every successful run re-queues the style's cover for the supplier digest** (`enqueueCoverForSupplier(styleId, coverId)` with `notifySupplier` defaulting to true).
- Delivery state per (style, base variantKey): `SupplierSendQueueItem` (`sharePointStatus === "UPLOADED"`, `sentAt != null`). `OutputDelivery` is dormant; don't use it.
- Styles using a layout: no helper. Recipe: all `prodSpec.outputs` → `parseProdSpecOutputs` → enabled outputs whose base key is `layout:<id>` → `style.findMany({ prodSpecId in, archivedAt null, deletedAt null })`.
- Auth: roles ADMIN and REVIEWER. API gate style: `getSessionWithRole()` + `isAdmin(role)` / `canReview(role)` (works with the role-gate test mocks). Pages: `requireAdminPage()`.
- UI: raw Tailwind v4 + zinc palette + lucide-react, no component library; server `page.tsx` (`dynamic = "force-dynamic"`, maps rows to serialisable views) + `"use client"` sibling; clients `fetch("/api/admin/...")` then `router.refresh()`. No server actions. Polling helper `use-visible-poll.ts`.
- Email: `dispatchEmail({ type, to, subject, html, text, ... })` (`src/lib/email/dispatch.ts`); `RESEND_EMAILS !== "true"` → SIMULATED and logged. Templates in `src/lib/email/templates/*.ts`. Links from `PROD_SPEC_BASE_URL`.
- Images: browser `downscaleImage(file)` → data URL in JSON body → `decodeImageAttachments` → `Bytes` column; served by an ADMIN route with immutable cache headers (RejectionAttachment pattern).
- Next 16: route `params` are Promises; `src/proxy.ts` replaces middleware; route files set `export const runtime = "nodejs"`.
- Tests: `node --test` + tsx; pure modules colocated in `src/**`; route gate tests in `tests/**` with `mock.module`. Render-touching tests set a dummy `DATABASE_URL` before importing. Baseline: `tsc` clean, 1236 + 180 tests green (with a dummy `DATABASE_URL`).

## 4. Data model

One migration pair. `20261024110000_change_request_enums` (enum values only) then `20261024120000_change_requests` (tables). Both hand-written, additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, FK in `DO $$ … EXCEPTION WHEN duplicate_object`). Every reader of a new table degrades on P2021 (missing table) to an empty result, so pages stay up between merge and deploy.

Enum additions (own migration):
- `EmailType`: `CHANGE_REQUEST_UPDATE` (to requester), `CHANGE_REQUEST_NEEDS_CODE` (to developer).
- `TriggerSource`: `CHANGE_REQUEST` (scoped reruns after approval; manual kind; labelled "change request").

User references are loose string ids (no FK), like `UserNotification`.

```prisma
model OutputLayoutRevision {
  id                    String    @id @default(cuid())
  layoutId              String
  number                Int                 // per-layout sequence 1..n
  status                String              // DRAFT | PUBLISHED | DISCARDED | SUPERSEDED
  definition            Json                // proposed (draft) or published definition
  baseDefinition        Json                // live definition when the draft was made: diff + restore
  baseVersion           Int                 // OutputLayout.version at draft time; publish refuses on mismatch
  authorKind            String              // USER | AGENT
  authorUserId          String?
  changeRequestOutputId String?
  parentRevisionId      String?             // the draft this one revises
  ops                   Json?               // LayoutOp[] that produced it
  note                  String?
  publishedAt           DateTime?
  publishedById         String?
  publishedVersion      Int?                // OutputLayout.version after publish
  createdAt             DateTime  @default(now())
  layout OutputLayout @relation(fields: [layoutId], references: [id], onDelete: Cascade)
  @@unique([layoutId, number])
  @@index([layoutId, status])
  @@index([changeRequestOutputId])
  @@map("output_layout_revisions")
}

model ChangeRequest {
  id          String   @id @default(cuid())
  number      Int      @unique @default(autoincrement())  // shown as R-0001
  title       String
  status      String   // summary of its outputs: NEW | WORKING | IN_REVIEW | NEEDS_INFO | NEEDS_CODE | DONE | REJECTED
  message     String   // the pasted text, as written
  source      String   // ADMIN | REQUESTER
  createdById String
  customerId  String?
  poNumber    String?
  styleId     String?  // the picked style; null = all styles in the PO / unknown
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  outputs     ChangeRequestOutput[]
  attachments ChangeRequestAttachment[]
  messages    ChangeRequestMessage[]
  steps       ChangeRequestStep[]
  @@index([status, createdAt])
  @@index([createdById])
  @@map("change_requests")
}

model ChangeRequestOutput {           // one issue per output
  id                String    @id @default(cuid())
  requestId         String
  position          Int       @default(0)
  label             String               // "Solid polybag sticker"
  variantKey        String?              // base key, e.g. layout:<id>
  layoutId          String?
  styleId           String?              // representative style for proofs
  text              String               // the issue text for this output
  status            String               // NEW | WORKING | IN_REVIEW | NEEDS_INFO | NEEDS_CODE | APPROVED | PUBLISHED | REJECTED | FAILED
  currentRevisionId String?
  draftCount        Int       @default(0)
  awaitingToken     String?              // NEEDS_CODE: the token key we wait for
  codeSpec          Json?                // NEEDS_CODE: spec + build prompt
  impact            Json?                // last ImpactSummary for currentRevisionId
  rejectReason      String?
  approvedById      String?
  approvedAt        DateTime?
  publishedAt       DateTime?
  firstTryApproved  Boolean?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@index([requestId])
  @@index([status])
  @@map("change_request_outputs")
}

model ChangeRequestAttachment {
  id           String   @id @default(cuid())
  requestId    String
  outputId     String?
  data         Bytes
  mimeType     String
  fileName     String
  byteSize     Int
  uploadedById String?
  createdAt    DateTime @default(now())
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@index([requestId])
  @@map("change_request_attachments")
}

model ChangeRequestMessage {          // the review thread
  id           String   @id @default(cuid())
  requestId    String
  outputId     String?
  authorKind   String   // USER | AGENT | SYSTEM
  authorUserId String?
  kind         String   @default("message") // message | question | memory_suggestion | status
  body         String
  revisionId   String?  // the draft this message produced or refers to
  meta         Json?
  createdAt    DateTime @default(now())
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@index([requestId, createdAt])
  @@map("change_request_messages")
}

model ChangeRequestStep {             // agent run log: audit trail + cost
  id           String   @id @default(cuid())
  requestId    String
  outputId     String?
  kind         String   // split | read_images | tool:<name> | draft | proof | impact | gap | email | error ...
  summary      String
  model        String?
  inputTokens  Int?
  outputTokens Int?
  costUsd      Float?
  detail       Json?
  createdAt    DateTime @default(now())
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@index([requestId, createdAt])
  @@map("change_request_steps")
}

model AgentMemory {
  id              String    @id @default(cuid())
  scope           String    // GLOBAL | CUSTOMER | DOC_TYPE | MONDAY
  scopeRef        String?   // customerId, docType value, ...
  text            String
  state           String    // PROPOSED | KEPT | DISMISSED | FORGOTTEN
  sourceKind      String    // CORRECTION | AGENT_FINDING | REQUEST | MANUAL
  sourceRequestId String?
  usedCount       Int       @default(0)
  lastUsedAt      DateTime?
  createdById     String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([scope, state])
  @@map("agent_memories")
}
```

`OutputLayout` gains the back-relation `revisions OutputLayoutRevision[]`. Statuses, op unions and JSON shapes are defined once in `src/lib/change-requests/types.ts` (zod + TS unions) and imported everywhere.

## 5. Module map (file ownership in §8)

```
src/lib/change-requests/
  types.ts            status unions, zod schemas for JSON columns, ImpactSummary, CodeSpec, constants
  flags.ts            changeRequestsEnabled()  (env CHANGE_REQUESTS_ENABLED === "true")
  db-safe.ts          isMissingTable(err) (P2021/P2022) + helpers used by every reader
  store.ts            shared writes/reads: appendMessage, logStep, setOutputStatus (+ status roll-up),
                      createProposedMemory, getRequestDetail, getOutputWithRequest, getAttachmentImages
  requests.ts         create/list requests + outputs + attachments, form searches
  impact.ts           computeImpact(): pure compare + DB loader
  proofs.ts           pickRepresentatives(), renderProof()
  gap.ts              token catalogue + resolved values; CodeSpec + build prompt builder; resumeAwaitingCode()
  publish.ts          approveOutput(), rerunApproved(), rejectOutput()
  memory.ts           propose/keep/dismiss/forget, memoriesForPrompt()
  signals.ts          learning signals from outputs + revisions + steps
  emails.ts           requester + developer emails (templates in src/lib/email/templates/)
  agent/
    contract.ts       AgentTool / ToolResult / ToolContext types + the fixed tool names
    client.ts         Anthropic client (official SDK), model + effort from env, vision blocks, cost calc
    tools.ts          tool definitions (zod) + implementations: the ONLY surface agents act through
    job.ts            runChangeRequestJob(outputId, trigger): tool-use loop, steps log, rails
    prompt.ts         default system prompt (registered in SYSTEM_PROMPT_DEFS as "change-request-agent")
    split.ts          splitRequestByOutput(): cheap model call for pasted emails
src/lib/output-layouts/
  revisions.ts        createDraft, reviseDraft, listRevisions, discardDraft, publishRevision, restoreRevision
  ops.ts              LayoutOp union + applyLayoutOps(def, ops) (pure) + validation
  publish-validation.ts  validateLayoutForPublish(def) extracted from the publish route (route reuses it)
  render-output.ts    renderStyleOutput({ styleId|ctx, variantKey, definition? , mode }) faithful per-output render, extracted from styles/[id]/output-preview (route reuses it)
src/lib/pdf/renderer.ts  + renderHtmlPng({ html, widthMm, heightMm, scale })
scripts/cr-tools.ts   CLI over agent/tools.ts for the Claude Code trial: npx tsx --env-file=.env scripts/cr-tools.ts <tool> '<json>'
scripts/cr-bench.ts   test bench: replays cases, scores proposals
```

### 5.1 Revisions (`revisions.ts`)
- `createDraft({ layoutId, definition, authorKind, authorUserId?, changeRequestOutputId?, parentRevisionId?, ops?, note? })`: parses with `parseLayoutDef`, stores `baseDefinition` = current live def and `baseVersion` = current version, next `number`.
- `publishRevision(revisionId, { userId, force? })`: refuses unless status DRAFT; refuses with a typed conflict error if `layout.version !== baseVersion` or the live definition no longer deep-equals `baseDefinition` (someone edited in the builder meanwhile) unless `force`; runs `validateLayoutForPublish`; in one transaction writes `definition`, `status: PUBLISHED`, `version: { increment: 1 }`, marks revision PUBLISHED with `publishedVersion`, marks other open drafts of the layout SUPERSEDED; then `refreshLayoutVariants()`. The version bump is what makes `classifyOutput` see pending documents as changed.
- `restoreRevision(revisionId, { userId })`: creates a USER draft from that revision's `definition` (or `baseDefinition` for "restore what was live before") and publishes it, so history only ever moves forward.
- The Output Builder autosave is unchanged. The builder gets a read-only **History** panel (list + restore) and shows a notice when an open draft exists for the layout.

### 5.2 Layout operations (`ops.ts`, pure)
```ts
type LayoutOp =
  | { op: "add_block"; page: number; block: { id?: string; rect: Rect; lines: string[]; fontPt?: number; bold?: boolean; align?: "left"|"center"|"right"; valign?: "top"|"middle"|"bottom"; fitWidth?: boolean; lineHeight?: number } }
  | { op: "remove_block"; page: number; blockId: string }
  | { op: "set_rect"; page: number; blockId: string; rect: Rect }                 // move + resize
  | { op: "set_block_props"; page: number; blockId: string; props: Partial<Pick<LayoutBlock, "fontPt"|"bold"|"align"|"valign"|"fitWidth"|"fitHeight"|"lineHeight"|"invert"|"border">> }
  | { op: "edit_line"; page: number; blockId: string; line: number; oldText: string; newText: string }
  | { op: "insert_line"; page: number; blockId: string; line: number; text: string }
  | { op: "remove_line"; page: number; blockId: string; line: number; oldText: string };
applyLayoutOps(def: LayoutDef, ops: LayoutOp[]): { def: LayoutDef; applied: LayoutOp[]; rejected: { op: LayoutOp; reason: string }[]; warnings: string[] }
```
Blocks are addressed by id (stable after `parseLayoutDef`). Each op is checked; a rejected op does not abort the rest. Final def must pass `LayoutDefSchema` + page grid bounds. Every changed line passes `validateTokenRef` + `validateLineConditionals` + `validateLineCalcs`. Overlap with other blocks and likely text overflow (estimate from font size, characters and block width in mm) are **warnings**, not rejections; the proof render is the real fit check. Test: reproduce the polybag quantity block on a synthetic 50×60 mm def (a new block at col 7, row 42, 27×4 with `{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}`).

### 5.3 Faithful render (`render-output.ts`)
`renderStyleOutput({ styleId, variantKey, definition?, mode: "preview"|"production" })` returns `{ docs: { suffix: string|null; html: string; widthMm; heightMm }[]; unresolved: string[] }` using exactly the steps of the style output-preview route (context, augments, pins, carton prefs, dims, custom logo, layout images, repetition). When `definition` is given it renders that instead of the registry variant. The style output-preview route is refactored onto it (behaviour unchanged).

### 5.4 Impact (`impact.ts`)
`computeImpact({ layoutId, proposedDef, limit? }): ImpactSummary`
- Styles = enabled outputs on any ProdSpec whose base key is `layout:<layoutId>`, styles not archived/deleted.
- Per style (concurrency 4, StyleData built once and reused for both renders): render current (live def) and proposed via `renderStyleOutput` in production mode; normalise and compare HTML per doc.
- Join `getCurrentOutputsForStyles` (review status of the current asset) and `SupplierSendQueueItem` (uploaded / emailed) and in-flight jobs (QUEUED/RUNNING).
- Rows: `{ styleId, styleLabel, poNumber, variantKey, changed, reviewStatus: "PENDING_REVIEW"|"APPROVED"|"REJECTED"|"NONE", uploaded, emailed, inFlight }`; summary counts `{ styles, docs, changed, unchanged, changedByStatus, approvedChanged, deliveredChanged }`.
- Pure core (`compareDocs`, `summarise`) tested; loader tested with mocks. Scale: log duration; refuse > `limit` styles (default 400) with a clear message.

### 5.5 Proofs (`proofs.ts` + `renderHtmlPng`)
`renderHtmlPng({ html, widthMm, heightMm, scale = 3 })` in `renderer.ts`: same shared browser, viewport = mm → px at 96 dpi × scale, `document.fonts.ready`, fit-width pass, `page.screenshot({ clip })`. `pickRepresentatives(impact, def)`: one style per distinct changed doc signature, one per conditional branch present in the changed lines, plus one **control** style that does not change (shown as "no change, expected"). Route `GET /api/admin/change-requests/revisions/[revisionId]/proof?styleId=&side=before|after&doc=0` returns `image/png` (private cache).

### 5.6 Gap check + code handoff (`gap.ts`)
- `tokenCatalogue()` = `LAYOUT_TOKENS` with examples; `resolvedTokens(styleId)` = every text token's value for a style.
- The agent declares a gap with the `declare_gap` tool (`{ tokenKey, label, source: { board, column, examples: [{ value, count }] }, rule, cases: [{ input, output }] }`); the server rejects a declared gap whose `tokenKey` already exists. Output status → NEEDS_CODE, `awaitingToken`, `codeSpec` (with a generated build prompt naming the files: token-meta.ts, tokens.ts, the Monday mapping, a smoke-test batch, done criteria).
- Developer email (`CHANGE_REQUEST_NEEDS_CODE`) with a "Get build prompt" button → `/requests/[id]/build-prompt?output=` (ADMIN page with copy button).
- `resumeAwaitingCode()`: for NEEDS_CODE outputs whose `awaitingToken` is now in `LAYOUT_TOKENS` (i.e. the deploy is live), set WORKING and start the job. Called from the existing cron tick endpoint (`/api/jobs/run?sweep=1`) and on opening the request page. Idempotent.

### 5.7 Agent (`agent/*`)
- Client: official `@anthropic-ai/sdk`. Model `CHANGE_REQUEST_MODEL` env, default `claude-opus-5-5`; adaptive thinking; effort `high`; streaming with `finalMessage()`; server-side refusal fallback per the SDK docs; images as base64 image blocks; cost per step from `usage` (Opus 5.5: $4 / $20 per MTok in/out) logged to `ChangeRequestStep`. `ANTHROPIC_API_KEY` missing → typed `AiNotConfiguredError`, request shows "AI is not configured".
- Splitting a pasted email per output: `CHANGE_REQUEST_SPLIT_MODEL`, default `claude-haiku-5-5`, structured output.
- Tools (read + draft only): `get_request`, `find_styles_by_value` (SQL over `rawData->'column_values'` text, returns column id/title, customer, PO, styles; screenshots truncate, the DB has the full value), `find_layouts` (by customer/ProdSpec + doc type, plus the request's output picks), `get_layout` (def with block ids + rects + lines), `list_tokens` (catalogue + resolved values for a style), `propose_patch` (ops → `applyLayoutOps` → `createDraft`, returns applied/rejected/warnings), `render_proof` (PNG back to the model for self-check), `impact_list`, `declare_gap`, `ask_reviewer` (posts a question message, output → NEEDS_INFO), `propose_memory`, `finish` (plain-language summary for the reviewer). Max 30 tool calls per run; a `task_budget` if available.
- Job: `runChangeRequestJob(outputId, { trigger: "new"|"comment"|"resume" })` runs in-process (fire-and-forget from the route, status WORKING, steps logged; UI polls). A run left WORKING > 20 min is marked FAILED by the cron sweep. On comment: the thread since the last draft + the current draft go back in; the result is a new revision (`parentRevisionId`), `draftCount++`.
- System prompt (editable, key `change-request-agent`) includes: red lines/arrows/boxes mark where to look, read those first; "EXAMPLE" watermarks are layout references only, never copy their data; change only the named output; prefer existing tokens and conditionals; thresholds go inside a variable (`{{polybagQty}}` resolves only above one); render every draft on the request's style and one style it must not affect; keep the label stock size, never below 5 pt; ask instead of guessing when two readings are plausible. KEPT memories for global + customer + doc type + Monday are appended.

### 5.8 Approve, publish, rerun (`publish.ts`)
- `approveOutput(outputId, userId)`: ADMIN. Requires a current DRAFT revision → `publishRevision` → fresh impact on the published def → **scoped rerun** of changed docs that are not APPROVED and not in flight, grouped per style as `{ id, prodSpecId, variantKeys }` → `enqueueBulkRun({ ..., triggerSource: "CHANGE_REQUEST" })`. Returns `{ publishedVersion, rerun: { enqueued, batchId }, approvedChanged: Row[], deliveredChanged: Row[] }`. Status PUBLISHED, `firstTryApproved = draftCount === 1`. Requester gets the "live" email with a before/after.
- `rerunApproved(outputId, userId, styleIds)`: explicit second confirmation; reruns approved changed docs (they go back to review; delivery to the supplier happens only when someone approves them again, through the normal flow).
- `rejectOutput(outputId, userId, reason)`: reason required; draft DISCARDED; requester email.
- Runner change: for `triggerSource === "CHANGE_REQUEST"` call `enqueueCoverForSupplier(styleId, coverId, { notifySupplier: false })` at both call sites, so these reruns never land in the supplier digest; never auto-approve (layout autoApprove / spec "Fully approved" are skipped, so the new render goes to a person and is not captured into the supplier-send queue); and force a fresh layout registry load before rendering (`coverNotifiesSupplier`, `runMayAutoApprove`, `runNeedsFreshLayouts` in trigger-labels.ts). `enqueueBulkRun` gains an optional `triggerSource` (default MANUAL_BULK). `TRIGGER_LABELS`/`MANUAL_SOURCES` get CHANGE_REQUEST.

### 5.9 Memory + signals
- `memory.ts`: the job proposes 0–3 notes after a revision caused by a comment and after approval (`propose_memory` tool, state PROPOSED, shown in the thread as "Remember for <customer>?"). Keep / Dismiss in the thread or on `/settings/agent-memory` (filter by scope, edit, forget, restore, event log). `memoriesForPrompt({ customerId, docType })` returns KEPT notes and bumps `usedCount`.
- `signals.ts`: per output: drafts, first-try approved, reviewer edit kinds (from revision op diffs: size, position, wording, scope), time to approval, cost (sum of steps), reject reason. Shown as a table on `/requests` with totals (first-try rate, median drafts). The bench reads the same records.

## 6. Routes and pages

API (`export const runtime = "nodejs"`, gate style `getSessionWithRole` + `isAdmin`/`canReview`, all 404 when the flag is off):
- `GET|POST /api/admin/change-requests` (POST: `canReview`; REVIEWER creates `source: REQUESTER`)
- `GET /api/admin/change-requests/[id]` (ADMIN, or the REVIEWER who created it)
- `POST /api/admin/change-requests/[id]/run` (ADMIN) · `POST /api/admin/change-requests/[id]/messages` (ADMIN; with `outputId` triggers a revision run)
- `POST /api/admin/change-requests/split` (canReview; pasted text → per-output issues)
- `GET /api/admin/change-requests/[id]/attachments/[attachmentId]`
- `POST /api/admin/change-request-outputs/[id]/approve | rerun-approved | reject` (ADMIN)
- `GET /api/admin/change-requests/revisions/[revisionId]/proof | impact | diff` (ADMIN)
- `GET|POST /api/admin/output-layouts/[id]/revisions`, `POST /api/admin/output-layouts/revisions/[revisionId]/publish | restore` (ADMIN)
- `GET|PATCH /api/admin/agent-memory` (ADMIN)

Pages: `/requests` (inbox + signals), `/requests/new` (form: PO/style search → output picker with thumbnails → one issue per output; paste-and-split; screenshots), `/requests/[id]` (review: tab per output, draft selector, side-by-side + slider proofs, control style, impact table, definition diff, thread with composer and memory cards, approve/reject), `/requests/[id]/build-prompt`, `/settings/agent-memory`. Nav: "Requests" in `NAV` for admins and in the reviewer links, only when the flag is on.

## 7. Verification

This environment has no production database and no API key. Every work package ships: unit tests for pure modules, route gate tests (401/403/404 trio) for new routes, `tsc --noEmit` clean, the full `npm test` green with a dummy `DATABASE_URL`. Integration runs `next build` once. Live verification (real styles, real API key, the trial) is Niels's, on dev, behind the flag.

## 8. Build plan and file ownership

Integration branch `claude/change-requests`. Each package works in its own worktree and branch off it; only the orchestrator merges.

| Wave | Package | Ledger task | Owns |
|---|---|---|---|
| 0 | **Foundation** | Layout drafts (part) | schema + both migrations, `change-requests/{types,flags,db-safe}.ts`, `output-layouts/{revisions,publish-validation,render-output}.ts` + refactors of the publish and style output-preview routes onto them, `enqueueBulkRun` triggerSource, runner `notifySupplier:false`, trigger labels, all `TYPE_LABELS` maps, `@anthropic-ai/sdk` dependency |
| 1 | A · Ops | Layout edit operations | `output-layouts/ops.ts` (+ tests) |
| 1 | B · Impact | Impact list | `change-requests/impact.ts` (+ tests), impact route |
| 1 | C · Proofs | Before/after proofs | `renderHtmlPng`, `change-requests/proofs.ts`, proof route |
| 1 | D · History | Layout drafts (rest) | revision routes, Output Builder History panel + open-draft notice |
| 2 | E · Tools + gap | Assistant tools; Spot requests that need new code; Needs-code email | `agent/tools.ts`, `gap.ts`, `scripts/cr-tools.ts`, needs-code email template, build-prompt page, resume hook in the sweep route |
| 2 | F · Bench | Test bench | `scripts/cr-bench.ts`, synthetic fixtures under `scripts/cr-bench/` |
| 2 | G · Job | Assistant job | `agent/{client,job,prompt}.ts`, `SYSTEM_PROMPT_DEFS` entry, run + messages routes |
| 1 | H · Inbox + requester | Change requests inbox; Requester flow | `requests.ts`, `agent/split.ts`, `/requests` + `/requests/new`, create/split/search/attachment routes, requester emails (`emails.ts` + template), nav entries |
| 3 | I · Review + publish | Review screen; Approve → publish | `/requests/[id]`, `publish.ts`, approve/reject/rerun-approved + diff routes |
| 1 | J · Memory + signals | Memory notes; Learning signals | `memory.ts`, `signals.ts`, `/settings/agent-memory`, agent-memory routes, signals table component |

Orchestrator-owned: `change-requests/store.ts`, `agent/contract.ts`, the runner guards, and the one-line wiring between packages at integration (auto-start the job after create, mount the signals table on `/requests`). H and J moved into wave 1 because they only need the foundation. Waves start when the previous wave is merged into the integration branch. Packages inside a wave only touch files they own; anything outside their list goes back to the orchestrator.

## 9. Decisions (settled 2026-10-24)

1. **Trial gate placement.** The in-app phase is built now behind the flag; the trial gates the **rollout**.
2. **Official Anthropic SDK** (`@anthropic-ai/sdk@^1.3.0`) for the agent (tool use + vision + streaming). The existing ✨ AI fix stays on raw fetch.
3. **Feature flag** `CHANGE_REQUESTS_ENABLED`, default off, so the PR can merge before the trial.
4. **Who submits**: REVIEWERs can create requests and see their own; only ADMIN approves, publishes or reruns. Final say at the rollout gate.
