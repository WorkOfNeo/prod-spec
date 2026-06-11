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
