import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import {
  outputReadinessForStyle,
  type ReadinessStyle,
} from "@/lib/styles/output-readiness";
import { activeStylesWhere } from "@/lib/styles/active-filter";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { styleReadinessNotice, type ReadinessNotice } from "@/lib/styles/readiness-notice";
import { mondayItemUrl } from "@/lib/monday/url";

// =====================================================
// "Needs input" — the styles that need data before anything can generate.
//
// The review queue (getReviewBoard) only lists styles that have a rendered
// job (AWAITING_REVIEW). A style whose outputs are all blocked on missing data
// (no PO, no barcodes, missing Monday fields) never gets a job, so it stays
// invisible on /styles only. This surfaces those to reviewers WITHOUT
// generating blank PDFs: it's a pure readiness scan over exactly the /styles
// active set, reusing the same role-aware readiness notice the style pages show.
//
// Inclusion (all must hold):
//   • In the /styles active set (activeStylesWhere — same visibility rules).
//   • On an ACTIVE prod spec (an inactive/absent spec declares no outputs).
//   • Nothing generated yet (no non-FAILED asset) — a style with any rendered
//     output is already in the review tabs; its missing outputs show there.
//   • ≥1 non-excluded output is NOT ready (awaiting data). A style whose every
//     output is ready is left out — it will generate on its own, it's not
//     "needs input".
// =====================================================

export type NeedsInputStyle = {
  styleId: string;
  styleName: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  prodSpecId: string | null;
  // Suppliers-drive link for the "open SharePoint" remedy (admin PO fetch),
  // null when the supplier has no configured drive.
  sharepointUrl: string | null;
  // Deep link to the Monday item — the reviewer's remedy for "add it on Monday"
  // (missing fields / no PO). Always present on a Style.
  mondayUrl: string;
  // How many of the style's (non-excluded) outputs are still waiting on data,
  // out of the total — the "1 of 3 ready" the card shows.
  waiting: number;
  total: number;
  // The role-aware readiness diagnostic (source/PO → spec → missing fields),
  // same selector the style + review pages render.
  notice: ReadinessNotice;
  updatedAt: Date;
};

export async function getNeedsInputStyles(): Promise<NeedsInputStyle[]> {
  // ProdSpec.outputs may reference Output Builder layouts — load them before
  // the readiness walk resolves variants (same as /styles and current-outputs).
  await ensureLayoutVariantsLoaded();

  const [exclusionRules, docTypeLabels, activeWhere] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
    activeStylesWhere(),
  ]);

  const styles = await db.style.findMany({
    where: {
      AND: [
        activeWhere,
        // Active spec — inactive/absent scaffolds declare no outputs.
        { prodSpec: { is: { active: true } } },
        // Nothing generated yet — anything with a rendered asset already lives
        // in the review tabs (In Progress / Review), where its still-missing
        // outputs already surface.
        { jobs: { none: { status: { not: "FAILED" }, assets: { some: {} } } } },
      ],
    },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      poNumber: true,
      poFileName: true,
      cartonEan: true,
      eanStatus: true,
      eanAttempts: true,
      mondayItemId: true,
      mondayBoardId: true,
      businessArea: true,
      businessAreaRef: { select: { name: true } },
      supplier: { select: { country: true, sharepointUrl: true } },
      rawData: true,
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { name: true, config: true } },
      prodSpec: { select: { id: true, outputs: true, columnMapping: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const ignoredByStyle = await loadIgnoredOutputKeysByStyle(styles.map((s) => s.id));

  const out: NeedsInputStyle[] = [];
  for (const s of styles) {
    const readiness = outputReadinessForStyle(
      s as ReadinessStyle,
      exclusionRules,
      docTypeLabels,
      ignoredByStyle.get(s.id),
    );
    // Outputs that actually count as work (a doc-type rule or a per-style
    // operator ignore may exclude some).
    const active = readiness.filter((o) => !o.excluded);
    if (active.length === 0) continue; // nothing to generate for this style
    const waiting = active.filter((o) => !o.ready);
    if (waiting.length === 0) continue; // all ready → it will generate itself

    const prodSpecOutputs = parseProdSpecOutputs(s.prodSpec?.outputs ?? []);
    const notice = styleReadinessNotice(
      {
        eanStatus: s.eanStatus,
        eanAttempts: s.eanAttempts,
        poNumber: s.poNumber,
        poFileName: s.poFileName,
        hasProdSpec: true,
        prodSpecHasOutputs: prodSpecOutputs.some((o) => o.enabled !== false),
        // Light path: readiness (ready/missing) without generation state — none
        // is generated by construction.
        outputReadiness: readiness,
        hasPdfs: false,
        latestJobStatus: null,
      },
      "REVIEWER",
    );

    out.push({
      styleId: s.id,
      styleName: s.name,
      customerName: s.customer.name,
      businessArea: s.businessAreaRef?.name ?? s.businessArea ?? null,
      poNumber: s.poNumber ?? null,
      prodSpecId: s.prodSpec?.id ?? null,
      sharepointUrl: s.supplier?.sharepointUrl ?? null,
      mondayUrl: mondayItemUrl(s.mondayBoardId, s.mondayItemId) ?? "",
      waiting: waiting.length,
      total: active.length,
      notice,
      updatedAt: s.updatedAt,
    });
  }

  // Most-recently-touched first — the styles someone is actively working on
  // Monday surface at the top.
  out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return out;
}
