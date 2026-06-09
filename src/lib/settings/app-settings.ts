import { db } from "@/lib/db";

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
