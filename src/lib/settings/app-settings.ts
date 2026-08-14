import { db } from "@/lib/db";
import { normalizeVisibleColumns, type StyleColumnKey } from "@/lib/styles/table-columns";

// =====================================================
// Global, app-wide settings — a tiny key-value store backed by the
// AppSetting table (see prisma/schema.prisma). Feature code should go
// through a typed accessor pair here rather than reading the table
// directly, so the key strings and defaults live in one place.
// =====================================================

const AUTO_GENERATE_KEY = "autoGenerateEnabled";

// Master switch for automatic PDF generation.
//
// When ON: a style that reaches its ProdSpec's completion threshold
// auto-generates the outputs configured on its (Customer × Business Area)
// ProdSpec — via the Monday style webhook and the import-promotion path.
//
// When OFF: those auto-enqueue paths skip enqueuing. Styles still sync
// from Monday and ProdSpecs still scaffold; no PDFs are produced until a
// human runs them (manual re-run / admin test stay available regardless).
//
// Defaults to FALSE when unset — a fresh install does not auto-fire jobs
// until an admin turns it on at /settings.
export async function getAutoGenerateEnabled(): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: AUTO_GENERATE_KEY } });
  return row?.value === true;
}

export async function setAutoGenerateEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: AUTO_GENERATE_KEY },
    create: { key: AUTO_GENERATE_KEY, value: enabled },
    update: { value: enabled },
  });
}

const TRANSLATION_SYNC_STATE_KEY = "translationSyncState";

// Bookkeeping for the AUTOMATIC translations re-sync — the coalescing guard
// behind the Monday Translations-board webhook (see
// src/lib/monday/translations-auto-sync.ts). This is NOT a user-facing toggle;
// automatic re-sync is always on. It just lets a burst of cell edits collapse
// into at most one in-flight sink + one trailing catch-up instead of one full
// board re-sink per changed cell. Both fields are ISO-8601 UTC strings, with
// "" meaning unset (we store strings, never JSON null).
//   • requestedAt — the newest webhook that asked for a refresh (demand).
//   • runningAt   — when the active run claimed the slot ("" = idle).
export type TranslationSyncState = {
  requestedAt: string;
  runningAt: string;
};

export async function getTranslationSyncState(): Promise<TranslationSyncState> {
  const row = await db.appSetting.findUnique({ where: { key: TRANSLATION_SYNC_STATE_KEY } });
  const value = (row?.value ?? null) as Partial<TranslationSyncState> | null;
  return {
    requestedAt: typeof value?.requestedAt === "string" ? value.requestedAt : "",
    runningAt: typeof value?.runningAt === "string" ? value.runningAt : "",
  };
}

export async function setTranslationSyncState(state: TranslationSyncState): Promise<void> {
  await db.appSetting.upsert({
    where: { key: TRANSLATION_SYNC_STATE_KEY },
    create: { key: TRANSLATION_SYNC_STATE_KEY, value: state },
    update: { value: state },
  });
}

const COVER_REGEN_QUEUE_KEY = "coverRegenQueue";

// Debounce ledger for the AUTOMATIC cover refresh (see
// src/lib/pdf/cover-regen-schedule.ts). Each output approval/rejection stamps
// its style with dueAt = now + debounce, so a burst of per-output decisions
// collapses to ONE cover regen fired after the last one (rather than a render
// per click). Map of styleId → ISO-8601 due time; entries are removed as they
// are processed, so it only ever holds styles decided in the last few seconds.
// A plain JSON blob (no migration, no per-style column) — the same key-value
// store the translation coalesce guard uses. The map shape + the pure
// due/claim helpers live in the import-free leaf src/lib/pdf/cover-regen-ledger.
export type { CoverRegenQueue } from "@/lib/pdf/cover-regen-ledger";
import type { CoverRegenQueue } from "@/lib/pdf/cover-regen-ledger";

export async function getCoverRegenQueue(): Promise<CoverRegenQueue> {
  const row = await db.appSetting.findUnique({ where: { key: COVER_REGEN_QUEUE_KEY } });
  const value = (row?.value ?? null) as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return {};
  const out: CoverRegenQueue = {};
  for (const [styleId, iso] of Object.entries(value)) {
    if (typeof iso === "string") out[styleId] = iso;
  }
  return out;
}

export async function setCoverRegenQueue(queue: CoverRegenQueue): Promise<void> {
  await db.appSetting.upsert({
    where: { key: COVER_REGEN_QUEUE_KEY },
    create: { key: COVER_REGEN_QUEUE_KEY, value: queue },
    update: { value: queue },
  });
}

const SUPPLIER_BATCH_SEND_KEY = "supplierBatchSendEnabled";

// Master switch for the nightly supplier-send system (WS2).
//
// When OFF (the default): the send-queue still POPULATES as outputs are
// approved and /settings/approved shows exactly what would be pushed +
// emailed — but NOTHING is pushed to SharePoint and NO supplier email is
// sent. The midnight cron runs in dry-run (records a batch, sends nothing).
//
// When ON: approved outputs eagerly push to the supplier's SharePoint folder,
// and the midnight cron sends one digest email per supplier. (Real email still
// additionally requires RESEND_EMAILS — this flag gates the batch behaviour,
// RESEND_EMAILS gates whether any email actually leaves the building.)
//
// Defaults to FALSE so the whole pipeline can ship + be watched safely before
// an admin flips it on here once they trust the queue.
export async function getSupplierBatchSendEnabled(): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: SUPPLIER_BATCH_SEND_KEY } });
  return row?.value === true;
}

export async function setSupplierBatchSendEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: SUPPLIER_BATCH_SEND_KEY },
    create: { key: SUPPLIER_BATCH_SEND_KEY, value: enabled },
    update: { value: enabled },
  });
}

const SUPPLIER_SEND_MIN_PO_KEY = "supplierSendMinPo";

// PO-number cutoff for the supplier-send BACKFILL (WS3) — "reconcile
// previously-approved outputs into the send queue from this PO onward".
// Styles approved before the queue existed have no queue rows; the recurring
// reconcile sweep enqueues them, but ONLY at/above this cutoff so flipping the
// system on can't blast suppliers with years-old styles.
//
// Fallback: when UNSET, follows the generation cutoff (getGenerationMinPo,
// which itself falls back to the scrape cutoff). When the WHOLE chain is
// unset the reconciler does NOTHING — the backfill never runs uncapped; an
// explicit cutoff somewhere up the chain is the opt-in. Event-driven capture
// at approve time is unaffected by this cutoff.
export async function getSupplierSendMinPo(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: SUPPLIER_SEND_MIN_PO_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  if (value !== null && Number.isFinite(value) && value > 0) return value;
  return getGenerationMinPo();
}

// Whether a supplier-send cutoff is set EXPLICITLY (vs. following the
// generation cutoff) — lets the UI show "following generation cutoff".
export async function getSupplierSendMinPoExplicit(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: SUPPLIER_SEND_MIN_PO_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export async function setSupplierSendMinPo(cutoff: number | null): Promise<void> {
  if (cutoff === null) {
    // Cleared — drop the row (falls back to the generation cutoff via the getter).
    await db.appSetting.deleteMany({ where: { key: SUPPLIER_SEND_MIN_PO_KEY } });
    return;
  }
  await db.appSetting.upsert({
    where: { key: SUPPLIER_SEND_MIN_PO_KEY },
    create: { key: SUPPLIER_SEND_MIN_PO_KEY, value: cutoff },
    update: { value: cutoff },
  });
}

const PO_EAN_AUTO_RUN_KEY = "poEanAutoRunEnabled";

// Master switch for AUTOMATIC PO→EAN resolution (the barcode scrape).
//
// When ON: the Railway cron and the fire-and-forget trigger after a Monday
// ingest drain PENDING styles automatically — each scrape downloads the PO
// PDF from SharePoint and parses the barcodes.
//
// When OFF: queueing still happens (a filled PO flips the style to PENDING
// and it shows on /po-eans), but nothing scrapes until a signed-in operator
// clicks "Re-resolve" (per row or batch) on /po-eans. Manual clicks work
// regardless of this switch.
//
// Defaults to FALSE when unset — same convention as autoGenerateEnabled:
// automation is opt-in, an admin flips it on from /po-eans when ready.
export async function getPoEanAutoRunEnabled(): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: PO_EAN_AUTO_RUN_KEY } });
  return row?.value === true;
}

export async function setPoEanAutoRunEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: PO_EAN_AUTO_RUN_KEY },
    create: { key: PO_EAN_AUTO_RUN_KEY, value: enabled },
    update: { value: enabled },
  });
}

const AUTOMATION_MIN_PO_KEY = "automationMinPo";

// PO-number cutoff for the EAN SCRAPE — the delimiter for "scrape from this PO
// onward". Auto-scrape only acts on styles whose PO sequence (Style.poSeq, the
// numeric part of the PO — see parsePoNumberValue) is >= this value. Orders
// before the cutoff are parked: never auto-scraped, but still scrape-able
// per-row from /po-eans. Stored as the numeric part (e.g. 63144 for
// "C-PO63144"). null / unset = no cutoff (scrape everything). Mirrors the
// /styles done-group PO cutoff; manual actions ignore it.
//
// NOTE: generation has its OWN cutoff (generationMinPo, below) — keeping a tight
// scrape cutoff (don't re-pull ancient SharePoint POs) no longer forces the
// generation backlog to stay parked too.
export async function getAutomationMinPo(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: AUTOMATION_MIN_PO_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export async function setAutomationMinPo(cutoff: number | null): Promise<void> {
  if (cutoff === null) {
    // Cleared — drop the row (Prisma's Json type has no plain null write).
    await db.appSetting.deleteMany({ where: { key: AUTOMATION_MIN_PO_KEY } });
    return;
  }
  await db.appSetting.upsert({
    where: { key: AUTOMATION_MIN_PO_KEY },
    create: { key: AUTOMATION_MIN_PO_KEY, value: cutoff },
    update: { value: cutoff },
  });
}

const GENERATION_MIN_PO_KEY = "generationMinPo";

// PO-number cutoff for the GENERATION backlog sweep — "auto-generate ready
// outputs from this PO onward". Decoupled from the scrape cutoff so the two can
// be tuned independently: a tight scrape cutoff (don't re-pull old POs) without
// parking the generation backlog.
//
// Fallback: when this is UNSET, generation follows the scrape cutoff
// (getAutomationMinPo) — so adding this feature changes nothing until an admin
// sets a generation cutoff explicitly. Set it lower than the scrape cutoff to
// reach further back for generation; clear it to fall back to the scrape value.
//
// Applies to the bounded BACKLOG sweep only (sweepReadyStyleGenerations). The
// event-driven paths (Monday webhook, EAN→generation handoff) generate
// newly-ready styles regardless of this cutoff. Styles with no parseable PO
// (poSeq IS NULL) are NOT parked by it — they can't be placed on the PO
// timeline, and a ready output should still generate.
export async function getGenerationMinPo(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: GENERATION_MIN_PO_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  if (value !== null && Number.isFinite(value) && value > 0) return value;
  // Unset — follow the scrape cutoff so behaviour is unchanged until set.
  return getAutomationMinPo();
}

// Whether a generation cutoff is set EXPLICITLY (vs. following the scrape
// cutoff). Lets the UI show "following scrape cutoff" instead of a bare number.
export async function getGenerationMinPoExplicit(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: GENERATION_MIN_PO_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export async function setGenerationMinPo(cutoff: number | null): Promise<void> {
  if (cutoff === null) {
    // Cleared — drop the row (falls back to the scrape cutoff via the getter).
    await db.appSetting.deleteMany({ where: { key: GENERATION_MIN_PO_KEY } });
    return;
  }
  await db.appSetting.upsert({
    where: { key: GENERATION_MIN_PO_KEY },
    create: { key: GENERATION_MIN_PO_KEY, value: cutoff },
    update: { value: cutoff },
  });
}

const DONE_GROUP_PO_CUTOFF_KEY = "doneGroupPoCutoff";

// Done-group visibility cutoff for /styles.
//
// Styles whose Monday group is "Done" are normally hidden from the styles
// list. When this cutoff is set (a PO number — stored as its numeric part,
// e.g. 63144 for "C-PO63144"), Done-group styles whose PO parses ABOVE the
// cutoff are shown in the main list — the review window for backfilled
// orders. Unset/empty ⇒ all Done-group styles stay hidden (the default).
export async function getDoneGroupPoCutoff(): Promise<number | null> {
  const row = await db.appSetting.findUnique({ where: { key: DONE_GROUP_PO_CUTOFF_KEY } });
  const value = typeof row?.value === "number" ? row.value : null;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export async function setDoneGroupPoCutoff(cutoff: number | null): Promise<void> {
  if (cutoff === null) {
    // Cleared — drop the row (Prisma's Json type has no plain null write).
    await db.appSetting.deleteMany({ where: { key: DONE_GROUP_PO_CUTOFF_KEY } });
    return;
  }
  await db.appSetting.upsert({
    where: { key: DONE_GROUP_PO_CUTOFF_KEY },
    create: { key: DONE_GROUP_PO_CUTOFF_KEY, value: cutoff },
    update: { value: cutoff },
  });
}

const MONDAY_WRITEBACK_KEY = "mondayWriteBackEnabled";

// Master switch for OUTBOUND Monday status write-backs (us → Monday).
//
// When ON: the approval chain-reaction flips the Styles board subitems
// 01e/01f to "Approved". That is the ONLY automated Monday write, and it
// always goes through writeBackStatus() (src/lib/monday/writeback.ts).
// Rejections NEVER write back to Monday — not even a "Rejected" status.
//
// When OFF: nothing is written to Monday. Every write that WOULD have
// happened is still recorded to the write-back log (a `monday.writeback`
// Log row with readable "<name> <column>: <from> → <to>") so an admin can
// preview exactly what will fire before enabling.
//
// Defaults to FALSE when unset — outbound writes are opt-in, flipped on from
// the Monday → Webhooks tab once the column mapping has been confirmed.
// (Inbound webhooks + email notifications are unaffected by this switch.)
export async function getMondayWriteBackEnabled(): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: MONDAY_WRITEBACK_KEY } });
  return row?.value === true;
}

export async function setMondayWriteBackEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: MONDAY_WRITEBACK_KEY },
    create: { key: MONDAY_WRITEBACK_KEY, value: enabled },
    update: { value: enabled },
  });
}

const REVIEW_NOTIFICATION_KEY = "reviewNotificationEmails";

// Internal recipient(s) of the post-generation notifications: the
// "ready for review" email sent when a job finishes rendering, and the
// "fixed — ready for re-review" email sent from the rejection log.
// Entered comma-separated at /settings/notifications (DB-backed); the
// REVIEW_NOTIFICATION_EMAIL env var stays as a fallback so existing
// deployments keep notifying until the setting is filled in.

// The stored value only — what the settings page shows in its input.
export async function getStoredReviewNotificationEmails(): Promise<string[]> {
  const row = await db.appSetting.findUnique({ where: { key: REVIEW_NOTIFICATION_KEY } });
  return parseEmailList(typeof row?.value === "string" ? row.value : "");
}

// The resolved recipients feature code should use: setting → env fallback.
export async function getReviewNotificationEmails(): Promise<string[]> {
  const stored = await getStoredReviewNotificationEmails();
  if (stored.length > 0) return stored;
  return parseEmailList(process.env.REVIEW_NOTIFICATION_EMAIL ?? "");
}

export async function setReviewNotificationEmails(raw: string): Promise<void> {
  const value = parseEmailList(raw).join(", ");
  await db.appSetting.upsert({
    where: { key: REVIEW_NOTIFICATION_KEY },
    create: { key: REVIEW_NOTIFICATION_KEY, value },
    update: { value },
  });
}

const SUPPLIER_REVIEW_CC_KEY = "supplierReviewCcEmails";

// Actual email address(es) CC'd on every supplier "ready for review" approval
// email — entered comma-separated by an admin at /settings. DB-backed so it
// can change without a redeploy. Returns a clean, de-duplicated list.
export async function getSupplierReviewCcEmails(): Promise<string[]> {
  const row = await db.appSetting.findUnique({ where: { key: SUPPLIER_REVIEW_CC_KEY } });
  return parseEmailList(typeof row?.value === "string" ? row.value : "");
}

export async function setSupplierReviewCcEmails(raw: string): Promise<void> {
  // Store the normalised, de-duplicated comma list.
  const value = parseEmailList(raw).join(", ");
  await db.appSetting.upsert({
    where: { key: SUPPLIER_REVIEW_CC_KEY },
    create: { key: SUPPLIER_REVIEW_CC_KEY, value },
    update: { value },
  });
}

const COVER_PAGE_INFO_MD_KEY = "coverPageInfoMd";

// GLOBAL cover-page content block — GitHub-flavoured markdown an admin edits at
// /settings/cover-page. Printed on the cover SHEET (page 1) of every bundle,
// below the required-packaging manifest, on top of each ProdSpec's own
// "General information" pages (which still ship after the cover sheet). This is
// company-wide boilerplate the supplier should always see — contact lines,
// standing instructions — that changes from time to time without a redeploy.
//
// Empty string ⇒ nothing printed (the block collapses away). Images are
// referenced by a short serve URL and stored in cover_page_images, re-inlined
// to data URLs at PDF render time (src/lib/pdf/inline-cover-images.ts).
export async function getCoverPageInfoMd(): Promise<string> {
  const row = await db.appSetting.findUnique({ where: { key: COVER_PAGE_INFO_MD_KEY } });
  return typeof row?.value === "string" ? row.value : "";
}

export async function setCoverPageInfoMd(markdown: string): Promise<void> {
  // Trim trailing whitespace only — internal markdown structure is preserved.
  const value = markdown.trimEnd();
  await db.appSetting.upsert({
    where: { key: COVER_PAGE_INFO_MD_KEY },
    create: { key: COVER_PAGE_INFO_MD_KEY, value },
    update: { value },
  });
}

const STYLES_TABLE_COLUMNS_KEY = "stylesTableColumns";

// Which columns the /styles table shows — the GLOBAL standard view every
// user gets, set by an ADMIN from the Columns popover on /styles (not a
// per-user preference). Stored as { visible: [...] }; unknown keys are
// dropped and locked columns forced on (normalizeVisibleColumns), so a
// stale saved config can never break rendering. Unset ⇒ STANDARD_VISIBLE
// (Completion hidden, Generation in its slot).
export async function getStylesTableColumns(): Promise<StyleColumnKey[]> {
  const row = await db.appSetting.findUnique({ where: { key: STYLES_TABLE_COLUMNS_KEY } });
  const visible = (row?.value as { visible?: unknown } | null)?.visible;
  return normalizeVisibleColumns(visible);
}

export async function setStylesTableColumns(visible: ReadonlyArray<string>): Promise<void> {
  const value = { visible: normalizeVisibleColumns(visible) };
  await db.appSetting.upsert({
    where: { key: STYLES_TABLE_COLUMNS_KEY },
    create: { key: STYLES_TABLE_COLUMNS_KEY, value },
    update: { value },
  });
}

// Split a free-typed list on comma / semicolon / newline, trim, drop blanks,
// de-dupe case-insensitively while preserving the entry order.
function parseEmailList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const email = part.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

const FILE_NAME_PRESETS_KEY = "outputFileNamePresets";

// Saved "Output file name" patterns for the Output Builder — a shared,
// user-grown library so the same naming convention doesn't get re-typed (and
// mistyped) on every new layout. Stored as { presets: [{ id, label,
// pattern }] }; the patterns are ordinary file-name expressions with
// {{tokens}}, resolved by the usual runner path — nothing here is a
// separate naming mechanism, it's just text the builder can paste in.
//
// Global by design: the convention belongs to the house, not to one admin.
export type FileNamePreset = { id: string; label: string; pattern: string };

const MAX_PRESETS = 60;

// Tolerant of a stale/hand-edited row: anything that isn't a well-formed
// entry is dropped rather than throwing, and ids are de-duped.
export function normalizeFileNamePresets(raw: unknown): FileNamePreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FileNamePreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, pattern } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof pattern !== "string") continue;
    const cleanId = id.trim().slice(0, 60);
    const cleanPattern = pattern.trim().slice(0, 160);
    if (!cleanId || !cleanPattern || seen.has(cleanId)) continue;
    seen.add(cleanId);
    out.push({
      id: cleanId,
      label: (typeof label === "string" ? label.trim() : "").slice(0, 80) || cleanPattern,
      pattern: cleanPattern,
    });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

export async function getFileNamePresets(): Promise<FileNamePreset[]> {
  return (await getFileNamePresetsRow()) ?? [];
}

// Same read, but distinguishing "never configured" (null) from "configured
// and empty" ([]) — the API seeds the house conventions only in the first
// case, so deleting every preset stays deleted.
export async function getFileNamePresetsRow(): Promise<FileNamePreset[] | null> {
  const row = await db.appSetting.findUnique({ where: { key: FILE_NAME_PRESETS_KEY } });
  if (!row) return null;
  return normalizeFileNamePresets((row.value as { presets?: unknown } | null)?.presets);
}

export async function setFileNamePresets(presets: ReadonlyArray<FileNamePreset>): Promise<FileNamePreset[]> {
  const value = { presets: normalizeFileNamePresets(presets) };
  await db.appSetting.upsert({
    where: { key: FILE_NAME_PRESETS_KEY },
    create: { key: FILE_NAME_PRESETS_KEY, value },
    update: { value },
  });
  return value.presets;
}

const COVER_CONTENT_STAMP_KEY = "coverContentStamp";

// Three timestamps behind the "your cover text changed, existing bundles still
// show the old version" banner on /settings/cover-page.
//
// Editing the global cover block or a spec's General information only affects
// NEWLY generated bundles; existing covers keep the old prose until someone
// runs the "Regenerate cover pages" sweep. Nothing used to say so, and the gap
// is invisible — the editor shows the new text, the supplier has the old one.
//
// Stored as timestamps rather than a boolean, and in the DB rather than
// component state, so the signal survives a reload and is visible to ANY admin
// or reviewer — not just whoever happened to type. Dismissing is per-estate for
// the same reason: it's one shared piece of prose, not a personal to-do.
//
// Banner shows when changedAt is newer than BOTH regeneratedAt and dismissedAt.
export type CoverContentStamp = {
  // Last edit to the global block or any spec's General information.
  changedAt: string | null;
  // Last FULLY completed regenerate sweep (a stopped run doesn't count — see
  // the `final` flag on the regenerate route).
  regeneratedAt: string | null;
  // Last time someone waved the banner away without running the sweep.
  dismissedAt: string | null;
};

const EMPTY_STAMP: CoverContentStamp = { changedAt: null, regeneratedAt: null, dismissedAt: null };

export async function getCoverContentStamp(): Promise<CoverContentStamp> {
  const row = await db.appSetting.findUnique({ where: { key: COVER_CONTENT_STAMP_KEY } });
  const v = (row?.value ?? null) as Partial<Record<keyof CoverContentStamp, unknown>> | null;
  if (!v || typeof v !== "object") return EMPTY_STAMP;
  const iso = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
  return {
    changedAt: iso(v.changedAt),
    regeneratedAt: iso(v.regeneratedAt),
    dismissedAt: iso(v.dismissedAt),
  };
}

// Fail-soft on purpose at every call site: a stamp hiccup must never break the
// save (or the sweep) that triggered it. The banner is a convenience, not a
// correctness gate — worst case it doesn't show, exactly as before it existed.
async function patchCoverContentStamp(patch: Partial<CoverContentStamp>): Promise<void> {
  const next = { ...(await getCoverContentStamp()), ...patch };
  await db.appSetting.upsert({
    where: { key: COVER_CONTENT_STAMP_KEY },
    create: { key: COVER_CONTENT_STAMP_KEY, value: next },
    update: { value: next },
  });
}

export async function stampCoverContentChanged(at = new Date()): Promise<void> {
  await patchCoverContentStamp({ changedAt: at.toISOString() });
}

export async function stampCoverRegenerated(at = new Date()): Promise<void> {
  await patchCoverContentStamp({ regeneratedAt: at.toISOString() });
}

export async function stampCoverBannerDismissed(at = new Date()): Promise<void> {
  await patchCoverContentStamp({ dismissedAt: at.toISOString() });
}

// Pure so it can be unit-tested without a DB. Newer-than-both, with a null
// changedAt meaning "nothing has been edited since this feature shipped".
export function coverContentIsStale(stamp: CoverContentStamp): boolean {
  if (!stamp.changedAt) return false;
  const changed = Date.parse(stamp.changedAt);
  if (Number.isNaN(changed)) return false;
  const settled = [stamp.regeneratedAt, stamp.dismissedAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => !Number.isNaN(n));
  return settled.every((n) => changed > n);
}
