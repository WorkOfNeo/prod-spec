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
