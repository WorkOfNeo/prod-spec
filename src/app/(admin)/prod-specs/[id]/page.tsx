import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  parseBundlePageSettings,
  parseProdSpecColumnMapping,
  parseProdSpecLanguages,
  parseProdSpecOutputs,
  parseProdSpecRequiredFields,
} from "@/lib/prod-spec/config";
import { allVariants } from "@/lib/pdf/template-registry";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { formatDate } from "@/lib/utils";
import { listActiveLanguages } from "@/lib/languages/active";
import { loadCareLabels } from "@/lib/care-labels";
import { toLaunderingAction } from "@/lib/care-labels/actions";
import {
  loadTranslationDictionary,
  normaliseTranslationKey,
} from "@/lib/translations/lookup";
import { ProdSpecEditor } from "./prod-spec-editor";
import type { ApprovalPanelStyle } from "./approve-styles-panel";
import {
  getCurrentOutputsForStyle,
  rollupOutputSlots,
  type StyleOutputRollup,
} from "@/lib/outputs/current-outputs";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prodSpec = await db.prodSpec.findUnique({ where: { id }, select: { name: true } });
  return { title: prodSpec ? `${prodSpec.name} · Prod spec` : "Prod spec" };
}

export default async function ProdSpecDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAdminPage();
  // Published Output Builder layouts join the variant catalogue below.
  await ensureLayoutVariantsLoaded();

  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const prodSpec = await db.prodSpec.findUnique({
    where: { id },
    include: {
      customer: true,
      businessArea: true,
      suppliers: { select: { id: true } },
    },
  });
  if (!prodSpec) notFound();

  const [languages, careLabels, washSymbolRows, dict, docTypeLabels, testStyles, approvalPanel] =
    await Promise.all([
      listActiveLanguages(),
      loadCareLabels(),
      db.washSymbol.findMany({
        where: { active: true },
        orderBy: { code: "asc" },
        select: { code: true, name: true, action: true, restrictive: true },
      }),
      loadTranslationDictionary(),
      loadDocTypeLabels(),
      // Styles linked to this prod spec — the Test tab's style picker. Most
      // recent first; archived/deleted hidden to match the rest of the app.
      db.style.findMany({
        where: { prodSpecId: id, deletedAt: null, archivedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, poNumber: true, status: true, completionPct: true },
        take: 500,
      }),
      loadApprovalPanelStyles(id),
    ]);

  // Per care label: its Translation-board entry ({ lang → text }) so the
  // "generated from standard" panel can compose lines + flag coverage gaps
  // client-side without re-querying.
  const careTranslationsByLabel = Object.fromEntries(
    careLabels.map((label) => [
      label.id,
      dict.get(normaliseTranslationKey(label.sourceText))?.translations ?? {},
    ]),
  );

  // Defensive parse — if stored JSON is malformed for any reason, fall back
  // to empty defaults so the editor still renders.
  const outputs = safeParse(() => parseProdSpecOutputs(prodSpec.outputs), []);
  const careInstructionsByLang = parseLangMap(prodSpec.careInstructionsByLang);
  const outputLanguages = safeParse(() => parseProdSpecLanguages(prodSpec.outputLanguages), []);

  // Column mapping / required fields / suppliers left the editor (they're
  // managed at Customer level and via the supplier-link flow) — but the DB
  // values still apply at render time, so hidden overrides surface as
  // read-only notice chips instead of silent state.
  const hasColumnMappingOverride =
    Object.keys(safeParse(() => parseProdSpecColumnMapping(prodSpec.columnMapping), {})).length > 0;
  const hasRequiredFieldsOverride =
    safeParse(() => parseProdSpecRequiredFields(prodSpec.requiredFields), []).length > 0;

  return (
    <div className="px-8 py-8">
      <Link href="/prod-specs" className="text-xs text-zinc-500 underline">
        ← All prod specs
      </Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{prodSpec.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {prodSpec.customer.name} · {prodSpec.businessArea.name} · updated{" "}
            {formatDate(prodSpec.updatedAt)}
          </p>
        </div>
      </div>

      <ProdSpecEditor
        prodSpecId={prodSpec.id}
        styles={testStyles}
        initialTab={
          tab === "outputs"
            ? "outputs"
            : tab === "cover"
              ? "cover"
              : tab === "test"
                ? "test"
                : "general"
        }
        initialName={prodSpec.name}
        initialActive={prodSpec.active}
        initialFullyApproved={prodSpec.fullyApproved}
        initialThreshold={prodSpec.autoGenerateThresholdPct}
        initialOutputs={outputs}
        initialLogoSvg={prodSpec.logoSvg}
        initialGeneralInfoMd={prodSpec.generalInfoMd ?? ""}
        initialBundlePageSettings={parseBundlePageSettings(prodSpec.bundlePageSettings)}
        initialCareInstructionsByLang={careInstructionsByLang}
        initialOutputLanguages={outputLanguages}
        availableLanguages={languages}
        hasColumnMappingOverride={hasColumnMappingOverride}
        hasRequiredFieldsOverride={hasRequiredFieldsOverride}
        attachedSupplierCount={prodSpec.suppliers.length}
        approvalStyles={approvalPanel.styles}
        approvalStylesTotal={approvalPanel.totalCount}
        variantCatalogue={allVariants().map((v) => ({
          key: v.key,
          docType: v.docType,
          docTypeLabel: docTypeLabel(v.docType, docTypeLabels),
          name: v.name,
          description: v.description,
          defaultWidthMm: v.defaultWidthMm,
          defaultHeightMm: v.defaultHeightMm,
        }))}
        careLabels={careLabels.map((l) => ({
          id: l.id,
          sourceText: l.sourceText,
          sortOrder: l.sortOrder,
          action: l.action,
          showIfSymbols: l.showIfSymbols,
          hideIfSymbols: l.hideIfSymbols,
        }))}
        washSymbols={washSymbolRows.map((s) => ({
          code: s.code,
          name: s.name,
          action: toLaunderingAction(s.action),
          restrictive: s.restrictive,
        }))}
        careTranslationsByLabel={careTranslationsByLabel}
      />
    </div>
  );
}

// How many of the spec's live styles the approval panel loads rollups for.
// Each rollup is a handful of queries (getCurrentOutputsForStyle), so the list
// is capped at the most recently updated styles; the panel shows the cap.
const APPROVAL_PANEL_LIMIT = 300;

// Every live style on this prod spec, grouped by supplier in the panel, with
// the SAME cross-job slot rollup the review page shows (getCurrentOutputsFor-
// Style → rollupOutputSlots) so "outputs ready" here matches what a reviewer
// sees. `approvable` mirrors the approve-styles route's rule: the retroactive
// bulk publish only applies while the style's LATEST job is AWAITING_REVIEW.
async function loadApprovalPanelStyles(
  prodSpecId: string,
): Promise<{ styles: ApprovalPanelStyle[]; totalCount: number }> {
  const where = { prodSpecId, deletedAt: null, archivedAt: null };
  const [styles, totalCount] = await Promise.all([
    db.style.findMany({
      where,
      select: {
        id: true,
        name: true,
        poNumber: true,
        supplier: { select: { name: true } },
        jobs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: APPROVAL_PANEL_LIMIT,
    }),
    db.style.count({ where }),
  ]);
  if (styles.length === 0) return { styles: [], totalCount };

  // Rollups with bounded concurrency — hundreds of sequential per-style walks
  // would crawl, hundreds in parallel would swamp the pg pool.
  const rollups = new Map<string, StyleOutputRollup>();
  const pending = [...styles];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let s = pending.shift(); s; s = pending.shift()) {
        try {
          rollups.set(s.id, rollupOutputSlots(await getCurrentOutputsForStyle(s.id)));
        } catch {
          // Row renders without counts rather than sinking the whole page.
        }
      }
    }),
  );

  return {
    totalCount,
    styles: styles.map((s) => {
      const r = rollups.get(s.id);
      return {
        id: s.id,
        name: s.name,
        poNumber: s.poNumber,
        supplierName: s.supplier?.name ?? null,
        approvable: s.jobs[0]?.status === "AWAITING_REVIEW",
        toApprove: r?.toReview ?? 0,
        approved: r?.approved ?? 0,
        blocked: r?.blocked ?? 0,
        rejected: r?.rejected ?? 0,
        coming: (r?.awaitingData ?? 0) + (r?.readyToGenerate ?? 0) + (r?.generating ?? 0),
        excluded: r?.excluded ?? 0,
        total: r?.total ?? 0,
      };
    }),
  };
}

function safeParse<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Defensive coercion for the careInstructionsByLang JSON column.
// Bad shapes (arrays, primitives, non-string values) get dropped quietly.
function parseLangMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}
