import { db } from "@/lib/db";
import { renderPdf } from "@/lib/pdf/renderer";
import { ensureLayoutVariantsLoaded, layoutIdFromVariantKey } from "@/lib/output-layouts/variants";
import { buildStyleData } from "@/lib/styles/render-context";
import { outputReadinessForStyle, effectiveMapping } from "@/lib/styles/output-readiness";
import { effectiveStyleItem, resolveMappedField } from "@/lib/styles/resolved-fields";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { matchOutputRulesFor, exclusionReasonText } from "@/lib/outputs/exclusion";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { applyCartonBarcodePrefs, applyFieldOverrides } from "@/lib/pdf/pins";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";
import type { StyleData } from "@/lib/pdf/types";
import { defaultArtifactFileName, type TemplateVariant } from "@/lib/pdf/template-registry";
import { notifyReviewReady } from "@/lib/notifications/user-notifications";
import { supersedeOpenTicketsForStyleOp } from "@/lib/tickets/rejection-tickets";
import { findCarryForwardClaim } from "@/lib/review-flow/claim";
import { getReviewNotificationEmails, getCoverPageInfoMd } from "@/lib/settings/app-settings";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-pages";
import type { TriggerSource } from "@/generated/prisma/enums";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import {
  DEFAULT_OUTPUTS,
  parseBundlePageSettings,
  parseProdSpecColumnMapping,
  parseProdSpecOutputs,
  resolveOutputVariant,
  type ProdSpecOutput,
} from "@/lib/prod-spec/config";
import { eanResolveInputs, eanResolveKey } from "@/lib/po/resolve-inputs";
import { resolveAndPersistStyleEans } from "@/lib/po/ean-runner";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { enqueueApprovedAssetsForJob } from "@/lib/publish/supplier-send-queue";
import { enqueueCoverForSupplier } from "@/lib/publish/requeue-cover";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";
import { approvedOutputBaseKeysForStyle } from "@/lib/outputs/current-outputs";
import { assembleRequiredPackagingDocs, loadTrimSettings } from "@/lib/outputs/required-packaging";
import { manifestFingerprint } from "@/lib/trims/manifest";
import { resolveStyleTrimLabels } from "@/lib/trims/style-trims";
import { renderStyleCoverPdf } from "@/lib/pdf/cover";
import { coverFileName } from "@/lib/pdf/cover-file-name";
import { getSupplierSendMinPo } from "@/lib/settings/app-settings";
import { buildStyleCoverPdf } from "@/lib/pdf/style-cover";
import { toPlainBytes } from "@/lib/pdf/bytes";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { outputConfigKey } from "@/lib/outputs/output-config-key";
import {
  ignoreBaseKey,
  loadStyleFieldValues,
  mergeFieldOverrides,
} from "@/lib/outputs/output-field-values";
import {
  loadStyleLineValues,
  mergeLineValues,
  splitLineValues,
} from "@/lib/outputs/output-line-values";

const STALE_RUNNING_MS = 15 * 60 * 1000;

export type RunSummary = {
  processed: number;
  failed: number;
  jobIds: string[];
};

export async function runPendingJobs(limit = 5): Promise<RunSummary> {
  const summary: RunSummary = { processed: 0, failed: 0, jobIds: [] };

  await releaseStaleRunning();

  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob();
    if (!job) break;
    summary.jobIds.push(job.id);
    try {
      await processJob(job.id);
      summary.processed++;
    } catch (err) {
      summary.failed++;
      await markFailed(job.id, (err as Error).message);
    }
  }

  return summary;
}

async function claimNextJob(): Promise<{ id: string } | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
    SET status = 'RUNNING', "startedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'QUEUED'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  return rows[0] ?? null;
}

async function releaseStaleRunning(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const released = await db.job.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: { status: "QUEUED", startedAt: null },
  });
  if (released.count > 0) {
    await db.log.create({
      data: {
        level: "WARN",
        message: `released ${released.count} stale RUNNING jobs back to QUEUED`,
      },
    });
  }
}

// Catch a Sizes / Colour-code edit that landed on Monday since the last PO→EAN
// scrape and re-resolve before rendering. Ingest only re-queues a resolve when
// the PO NUMBER changes; a size/colour edit leaves the PO untouched, so the
// style_eans snapshot (and thus the printed labels/barcodes) would otherwise
// stay stale until a manual Re-resolve. We fingerprint the current resolve
// inputs (src/lib/po/resolve-inputs.ts) and compare to the one the last scrape
// stored on Style.eanResolveKey.
//
// Returns true when a re-resolve actually ran (the caller reloads the eans).
// Best-effort by design:
//   • no PO → nothing to resolve.
//   • column not migrated yet (the SELECT throws pre-db:deploy) → skip.
//   • first render for a style with no stored key → just start tracking (write
//     the key) rather than force a re-scrape, so a deploy can't stampede every
//     style through SharePoint at once.
async function maybeReResolveStaleEans(
  jobId: string,
  style: { id: string; rawData: unknown; name: string; poNumber: string | null },
  prodSpec: { columnMapping: unknown } | null,
  config: ReturnType<typeof parseCustomerConfig>,
): Promise<boolean> {
  if (!style.poNumber) return false;

  let storedKey: string | null;
  try {
    const row = await db.style.findUnique({
      where: { id: style.id },
      select: { eanResolveKey: true },
    });
    storedKey = row?.eanResolveKey ?? null;
  } catch {
    // eanResolveKey column not present yet (pre-db:deploy) — skip the check.
    return false;
  }

  const psRaw = prodSpec?.columnMapping;
  const mapping: ColumnMapping =
    psRaw && typeof psRaw === "object" && Object.keys(psRaw as object).length > 0
      ? parseProdSpecColumnMapping(psRaw)
      : config.columnMapping;
  const currentKey = eanResolveKey(
    eanResolveInputs(style.rawData, mapping, style.name, style.poNumber),
  );

  if (storedKey === null) {
    // First render since this style resolved (or since the feature shipped) —
    // start tracking without a forced re-scrape.
    await db.style.update({ where: { id: style.id }, data: { eanResolveKey: currentKey } });
    return false;
  }
  if (storedKey === currentKey) return false;

  await db.log.create({
    data: {
      jobId,
      level: "INFO",
      message: "re-resolving EANs before render — size/colour changed since last scrape",
    },
  });
  await resolveAndPersistStyleEans(style.id);
  return true;
}

export async function processJob(jobId: string): Promise<void> {
  // Load published Output Builder layouts into the variant registry so
  // `layout:<id>` keys resolve like any code-registered variant below
  // (resolveOutputVariant / outputReadinessForStyle are sync lookups).
  await ensureLayoutVariantsLoaded();

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      style: {
        // eanResolveKey (staleness check) and useStyleBoardColour (read by
        // buildStyleData via readUseStyleBoardColour) are both read separately +
        // guarded — omit them here so this critical render query never selects a
        // column that may not exist yet on a pre-db:deploy boot.
        omit: { eanResolveKey: true, useStyleBoardColour: true },
        include: {
          customer: true,
          qrImage: true,
          // Country feeds render fallbacks; name prints on the cover page.
          supplier: { select: { country: true, name: true } },
          // Display name for the review-ready email (falls back to the
          // free-text Style.businessArea when the mirror row isn't linked).
          businessAreaRef: { select: { name: true } },
          // Resolved PO barcodes — fall back into the ean13/cartonEan
          // fields at render time (see effectiveStyleItem). cartonEan is the
          // per-size carton feeding carton.perSize (repeatBy="cartonEan"); omit
          // it and that repeat generates only the assort row.
          eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true } },
        },
      },
    },
  });

  await db.log.create({ data: { jobId: job.id, level: "INFO", message: "job started" } });

  let config: ReturnType<typeof parseCustomerConfig>;
  try {
    config = parseCustomerConfig(job.style.customer.config);
  } catch (err) {
    throw new RunnerError("CONFIG_INVALID", `customer config invalid: ${(err as Error).message}`);
  }

  // Pull the ProdSpec (if resolved during ingest) so we can read its
  // per-output dimensions and supplier-specific overrides. When the Style
  // has no ProdSpec (manual entries, or ingests without a known BA), we
  // fall back to Customer.config-only defaults.
  const prodSpec = job.style.prodSpecId
    ? await db.prodSpec.findUnique({ where: { id: job.style.prodSpecId } })
    : null;

  // Re-resolve the PO barcodes first if a Sizes / Colour-code edit landed on
  // Monday since the last scrape (such an edit changes the size↔barcode map
  // but doesn't re-queue a resolve at ingest, so the style_eans snapshot would
  // otherwise print stale labels/barcodes). Best-effort: on a re-resolve, pull
  // the refreshed eans + carton EAN into the loaded style before building the
  // render context. A failure here must never fail the job — fall back to the
  // existing snapshot.
  try {
    const reResolved = await maybeReResolveStaleEans(job.id, job.style, prodSpec, config);
    if (reResolved) {
      const fresh = await db.style.findUnique({
        where: { id: job.style.id },
        select: {
          cartonEan: true,
          eans: {
            orderBy: { position: "asc" },
            select: { size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true },
          },
        },
      });
      if (fresh) {
        job.style.eans = fresh.eans;
        job.style.cartonEan = fresh.cartonEan;
      }
    }
  } catch (err) {
    await db.log.create({
      data: {
        jobId: job.id,
        level: "WARN",
        message: `pre-render EAN re-resolve skipped: ${(err as Error).message}`,
      },
    });
  }

  let styleData: StyleData;
  try {
    // One shared assembly for runner AND previews — fallback injection,
    // mapping priority (ProdSpec override → Customer config → manual ids),
    // per-ProdSpec context, wash-token repair. See
    // src/lib/styles/render-context.ts for the full resolution rules.
    styleData = await buildStyleData(
      {
        id: job.style.id,
        rawData: job.style.rawData,
        poNumber: job.style.poNumber,
        cartonEan: job.style.cartonEan,
        mondayBoardId: job.style.mondayBoardId,
        supplier: job.style.supplier,
        eans: job.style.eans,
        customer: { name: job.style.customer.name, config: job.style.customer.config },
        qrImage: job.style.qrImage ? { image: job.style.qrImage.image } : null,
      },
      prodSpec,
      config,
    );
  } catch (err) {
    throw new RunnerError("MAPPING_FAILED", `monday → style data mapping failed: ${(err as Error).message}`);
  }

  // Pick which variants to render. ProdSpec.outputs is the source of truth
  // when available — the operator selected those explicitly in the editor.
  // Falls back to DEFAULT_OUTPUTS (one of each variant) for manual styles
  // that haven't resolved a ProdSpec yet.
  let outputs: ProdSpecOutput[] = (() => {
    if (prodSpec) {
      const parsed = parseProdSpecOutputs(prodSpec.outputs);
      const enabled = parsed.filter((o) => o.enabled !== false);
      if (enabled.length > 0) return enabled;
    }
    return DEFAULT_OUTPUTS;
  })();
  // The FULL declared/enabled set, captured before the scope / durable-approval
  // / missing-field filters below narrow `outputs` down to this run's render
  // subset. The cover page lists ALL of these as "required packaging" (minus
  // per-style exclusions/ignores), regardless of what this run regenerates.
  const declaredEnabledOutputs = outputs;

  // Per-output generation: a job may be scoped to specific variant keys (the
  // auto-enqueue paths set these to the outputs whose own required fields
  // just landed). Empty ⇒ render all enabled outputs (manual full regen /
  // legacy rows). When scoped, re-check each output's required fields at run
  // time so a field that regressed since enqueue doesn't ship an incomplete
  // output — not-ready ones are skipped (logged), not failed.
  // Framing pages (__cover__ / __general_info__) derive from the outputs
  // and re-render on EVERY run — they can't be generated in isolation. A
  // rejection-ticket re-run scoped to one falls through to a full regen
  // (empty scope = all enabled outputs), which refreshes the framing
  // pages along the way; mixed scopes just drop the framing key.
  const scopedKeys: string[] = (
    Array.isArray(job.variantKeys)
      ? (job.variantKeys as unknown[]).filter((x): x is string => typeof x === "string")
      : []
  ).filter((k) => k !== COVER_VARIANT_KEY && k !== GENERAL_INFO_VARIANT_KEY);

  // Required-field gate (the source of truth: outputReadinessForStyle). An
  // output never renders unless every required Monday field it needs is
  // present — a blank/incomplete PDF must not ship. Skipped outputs surface on
  // the review surfaces as "can't generate — missing X" (AWAITING_DATA),
  // recomputed live from current data, so the operator sees exactly what's
  // blocking them. Applies to EVERY run, including a manual full regen, which
  // brings the runner in line with the auto-enqueue gate. Per-output required
  // fields are defined by the ProdSpec, so the gate engages only when one is
  // present (see the conditional below).
  // Per-style reviewer-supplied field values (inline fills / overrides) —
  // loaded once and used in BOTH the readiness gate (so a filled field lets a
  // previously-blocked output through this gate) and the render merge below (so
  // the value actually prints). Fail-soft empty until db:deploy lands the table.
  const fieldValues = await loadStyleFieldValues(job.styleId);
  // Per-style reviewer LINE rewrites (the catch-all beside field values, for
  // text no field pin can reach — including layout literals). Render-time only:
  // deliberately NOT consulted by the readiness gate, because rewriting a line
  // doesn't supply the missing column the rest of the output still needs.
  // Fail-soft empty until db:deploy lands the table.
  const lineValues = await loadStyleLineValues(job.styleId);

  const readyKeys = new Set(
    (prodSpec
      ? outputReadinessForStyle(
          {
            rawData: job.style.rawData,
            poNumber: job.style.poNumber,
            supplier: job.style.supplier,
            eans: job.style.eans,
            cartonEan: job.style.cartonEan,
            customer: { config: job.style.customer.config },
            prodSpec: { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping },
          },
          undefined,
          undefined,
          undefined,
          fieldValues,
        )
      : []
    )
      .filter((r) => r.ready)
      .map((r) => r.variantKey),
  );

  // Count of outputs dropped from a FULL regen because they're already
  // approved (durable approval, below). Lets the settle logic tell "empty
  // render set because everything is approved" (→ settle APPROVED, keep the
  // carried-forward approved assets) apart from a real misconfiguration.
  let approvedSkips = 0;

  // The style's currently-approved output bases (durable approval), read once.
  // Used BOTH to skip regenerating approved outputs on a full regen (below) AND
  // to flag them "Approved" on the cover's required-packaging manifest. Read
  // now (before this run's assets are persisted) it reflects PRIOR approvals —
  // exactly what the cover should show at generation time (this run's fresh
  // outputs are still pending review).
  const approvedBases = await approvedOutputBaseKeysForStyle(job.styleId);

  // Scoped re-runs (auto-enqueue / ticket fixes) narrow to specific outputs;
  // an empty scope is a full regen of every enabled output. Tickets reference
  // per-document asset keys ("layout:<id>#<size>"); ProdSpec outputs carry the
  // BASE key — match on the base so a per-document rejection re-runs its whole
  // variant.
  if (scopedKeys.length > 0) {
    const want = new Set(scopedKeys.map((k) => k.split("#")[0]));
    outputs = outputs.filter((o) => want.has(o.variantKey));
  } else {
    // FULL regen (no scope) — durable approval. An output the reviewer already
    // APPROVED must NOT be regenerated: a fresh PENDING_REVIEW asset would
    // supersede the approved one in the review view (which reads the latest
    // asset per base across all jobs), re-opening a decision that was closed.
    // So exclude the style's currently-approved bases from the render set;
    // their existing approved assets stay the latest and keep showing approved.
    //
    // Scoped re-runs (variantKeys set) never reach here — an EXPLICIT scoped
    // re-run of an approved output SHOULD regenerate it (reviewer intent),
    // exactly as before. approvedOutputBaseKeysForStyle uses the same
    // current-asset selection as the review page, so what we skip lines up with
    // what the reviewer sees as approved.
    if (approvedBases.size > 0) {
      const skipped: string[] = [];
      outputs = outputs.filter((o) => {
        if (approvedBases.has(o.variantKey)) {
          skipped.push(o.variantKey);
          return false;
        }
        return true;
      });
      approvedSkips = skipped.length;
      if (skipped.length > 0) {
        await db.log.create({
          data: {
            jobId: job.id,
            level: "INFO",
            message: `skipping ${skipped.length} already-approved output(s) — not regenerated (approval preserved): ${skipped.join(", ")}`,
          },
        });
      }
    }
  }

  // Drop outputs whose required fields aren't all present — skip (logged), not
  // fail, so the rest of the run proceeds and the cover still refreshes. Gated
  // when a ProdSpec exists (the source of required-field rules), OR for any
  // scoped run: a no-ProdSpec scoped run keeps its historical "skip all"
  // behaviour (readyKeys is empty), since scoped keys originate from ProdSpec
  // readiness. A no-ProdSpec FULL regen has no rules to apply and renders as
  // before (manual/default outputs).
  let missingFieldSkips = 0;
  if (prodSpec || scopedKeys.length > 0) {
    const next: ProdSpecOutput[] = [];
    for (const o of outputs) {
      if (!readyKeys.has(o.variantKey)) {
        missingFieldSkips++;
        await db.log.create({
          data: {
            jobId: job.id,
            level: "WARN",
            message: `skipping output ${o.variantKey}: required fields missing — not generated, surfaced as "awaiting data" on review`,
          },
        });
        continue;
      }
      next.push(o);
    }
    outputs = next;
  }

  type Generated = {
    variant: TemplateVariant;
    output: ProdSpecOutput;
    // Asset variantKey — the variant key, suffixed "#<part>" for multi-
    // document variants (Output Builder repeat-per-EAN: one file per row).
    variantKey: string;
    displayName: string;
    fileName: string;
    pdf: Buffer;
    // Placeholder artifacts (missing artwork tiles / "No carton EAN") found
    // in the rendered HTML — review-safe, blocks approval. 0 for static PDFs.
    placeholderCount: number;
  };
  const generated: Generated[] = [];
  // Info-area size catalogue, loaded once — resolves each info-area
  // output's per-style size pick to printed mm. Empty if the migration
  // isn't applied yet; outputs then fall back to their stored dims.
  const infoAreaSizes = await loadInfoAreaSizeMap();

  // Output-exclusion: a keyword rule can skip an output for this style —
  // either one of the OUTPUT's own (the layout's Settings tab: "only generate
  // when Product group contains shoes") or one on its DOC TYPE, which skips
  // every output of that type (e.g. socks/shoes → no wash-care). Resolved
  // through the SAME field resolver readiness/render use, so the runner and the
  // review page can never disagree on what's skipped. Doc-type rules are empty
  // before db:deploy ⇒ only output-level rules apply. `excludedOutputs` lets us
  // tell "all outputs intentionally skipped" apart from a real misconfiguration
  // below.
  const exclusionRules = await loadDocTypeExclusionRules();
  // Per-style operator ignores — skipped exactly like a rule hit, and counted
  // into excludedOutputs so an all-ignored run reads as intentionally empty
  // rather than NO_OUTPUTS.
  const ignoredKeys = await loadIgnoredOutputKeys(job.styleId);
  const exclusionLabels = await loadDocTypeLabels();
  // Built unconditionally: an output can carry rules of its own, so there is no
  // cheap "are any rules configured?" check to gate this on — and it's pure
  // in-memory work over data the job already loaded.
  const resolveExclusionField: (field: string) => string = (() => {
    const rStyle = {
      rawData: job.style.rawData,
      poNumber: job.style.poNumber,
      supplier: job.style.supplier,
      eans: job.style.eans,
      cartonEan: job.style.cartonEan,
      customer: { config: job.style.customer.config },
      prodSpec: prodSpec
        ? { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping }
        : null,
    };
    const item = effectiveStyleItem(rStyle);
    const mapping = effectiveMapping(rStyle);
    return (f: string) => resolveMappedField(item, mapping, f as keyof ColumnMapping);
  })();
  const excludedOutputs: string[] = [];

  for (const output of outputs) {
    const variant = resolveOutputVariant(output);
    if (!variant) {
      // Unknown variant — happens when a registered variant gets removed
      // from code but old ProdSpec rows still reference its key. Log and
      // skip rather than fail the whole job.
      await db.log.create({
        data: {
          jobId: job.id,
          level: "WARN",
          message: `skipping output: variant "${output.variantKey}" not in registry`,
        },
      });
      continue;
    }
    // Per-style operator ignore — never render this output for this style.
    if (ignoredKeys.has(variant.key)) {
      excludedOutputs.push(variant.key);
      await db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message: `skipping output ${variant.key}: ignored for this style`,
        },
      });
      continue;
    }
    // Keyword rules (the output's own, then its doc type's) — skip (don't
    // render) and record WHY, so the review surfaces an "Excluded" reason
    // instead of a perpetual "awaiting".
    const decided = matchOutputRulesFor(
      variant.generationRules,
      exclusionRules[variant.docType],
      resolveExclusionField,
    );
    if (decided) {
      const reason = exclusionReasonText(
        decided.hit,
        decided.scope === "output" ? variant.name : docTypeLabel(variant.docType, exclusionLabels),
      );
      excludedOutputs.push(variant.key);
      await db.log.create({
        data: { jobId: job.id, level: "INFO", message: `skipping output ${variant.key}: ${reason}` },
      });
      continue;
    }
    try {
      // Per-output pins ("customerName is ALWAYS …") and the carton barcode
      // preference applied on a copy — the base StyleData is shared across
      // this job's outputs. Standard generation is always SINGLE-style:
      // multi-style carton marking is a manual one-off (the carton dialog),
      // never standing config, so the runner never flips style.multipleStyles
      // and {{style2}}+ stay empty here.
      // Admin pins on the output ∪ this style's inline field values (per-style
      // wins), so a reviewer's filled/overridden value prints — the same merge
      // the readiness gate above used to let this output through.
      const baseKey = ignoreBaseKey(output.variantKey, variant.docType);
      const overrides = mergeFieldOverrides(output.fieldOverrides, fieldValues.get(baseKey));
      const renderStyle = applyCartonBarcodePrefs(
        applyFieldOverrides(styleData, overrides),
        output,
      );
      // Per-PDF overrides for a multi-document output: values keyed
      // "<base>#<suffix>" layer on top of the whole-output override for THAT
      // document only (a reviewer corrected one PDF of a repeat-per-EAN set).
      const docPrefix = `${baseKey}#`;
      const perDocOverrides = new Map<string, Record<string, string>>();
      for (const [k, v] of fieldValues) {
        if (k.startsWith(docPrefix)) perDocOverrides.set(k.slice(docPrefix.length), v as Record<string, string>);
      }
      // Same base-vs-per-document split for line rewrites.
      const lines = splitLineValues(lineValues, baseKey);
      // Printed size — the info-area size override (admin pick or custom)
      // when the variant is an info area, else the output's own dims.
      const dims = effectiveOutputDims(output, variant.isInfoArea ?? false, infoAreaSizes);
      // Static-pdf passthrough variants emit their source artwork bytes
      // verbatim; everything else renders HTML → PDF.
      if (!variant.staticPdf && variant.renderMany) {
        // Multi-document variant: one PDF per returned doc, each its own
        // JobAsset under "<key>#<suffix>".
        const docs = await variant.renderMany(
          renderStyle,
          dims,
          perDocOverrides.size > 0 ? perDocOverrides : undefined,
          lines.base || lines.perDoc.size > 0
            ? { base: lines.base, perDoc: lines.perDoc }
            : undefined,
        );
        for (const doc of docs) {
          const pdf = await renderPdf({ html: doc.html });
          const defaultName = fileNameFor(variant, styleData.styleNumber).replace(
            /\.pdf$/,
            `-${doc.suffix}.pdf`,
          );
          generated.push({
            variant,
            output,
            variantKey: docs.length > 1 ? `${variant.key}#${doc.suffix}` : variant.key,
            displayName: `${variant.name} · ${doc.suffix}`,
            fileName: doc.fileName ?? defaultName,
            pdf,
            placeholderCount: countPlaceholderMarkers(doc.html),
          });
        }
        continue;
      }

      let pdf: Buffer;
      let placeholderCount = 0;
      if (variant.staticPdf) {
        pdf = await variant.staticPdf();
      } else {
        // Single-document output: only the base key can carry line rewrites,
        // but merge anyway so a stray "#suffix" row can never be silently lost.
        const html = await variant.render(
          renderStyle,
          dims,
          mergeLineValues(lines.base, undefined),
        );
        placeholderCount = countPlaceholderMarkers(html);
        pdf = await renderPdf({ html });
      }
      generated.push({
        variant,
        output,
        variantKey: variant.key,
        displayName: `${variant.name} · ${dims.widthMm}×${dims.heightMm} mm`,
        fileName: variant.fileNameFor?.(renderStyle) ?? fileNameFor(variant, styleData.styleNumber),
        pdf,
        placeholderCount,
      });
    } catch (err) {
      const reason = (err as Error).message;
      const tag = reason.toLowerCase().includes("barcode") ? "BARCODE_FAILED" : "RENDER_FAILED";
      throw new RunnerError(tag, `${variant.key} render failed: ${reason}`);
    }
  }

  // FULL run where EVERY output is excluded by a doc-type keyword rule → this
  // style needs no documents. Finish CLEANLY (terminal APPROVED; no assets,
  // bundle pages or reviewer ping) so it settles instead of NO_OUTPUTS-failing
  // (which reads as an error and poisons the bulk-run float). Scoped/partial
  // runs fall through to the WARN path below — there `outputs` is only the
  // targeted/ready subset, so an all-excluded subset isn't the whole style.
  if (
    generated.length === 0 &&
    scopedKeys.length === 0 &&
    excludedOutputs.length > 0 &&
    excludedOutputs.length === outputs.length
  ) {
    await db.$transaction([
      db.jobAsset.deleteMany({ where: { jobId: job.id } }),
      db.job.update({ where: { id: job.id }, data: { status: "APPROVED", finishedAt: new Date() } }),
      db.style.update({ where: { id: job.styleId }, data: { status: "APPROVED" } }),
      // Full round, now needs no documents → any prior rejection is moot; clear
      // its threads to history so an excluded output can't pin the style to the
      // active rejection log.
      supersedeOpenTicketsForStyleOp(job.styleId),
      db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message:
            `no documents generated — all ${outputs.length} output(s) excluded by document-type ` +
            `keyword rules (${excludedOutputs.join(", ")}); this style needs none`,
        },
      }),
    ]);
    return;
  }

  // FULL run where every renderable output was carried forward as
  // already-approved (durable approval) and nothing else was left to generate.
  // The style is fully approved — settle it that way WITHOUT deleting any
  // assets (this job produced none; the approved assets live on PRIOR jobs and
  // must survive) and WITHOUT superseding tickets (there's nothing to re-review;
  // an approved output has no open ticket). This finishes cleanly instead of
  // NO_OUTPUTS-failing. Guarded to the pure-approval case: if fields were also
  // missing / outputs excluded, fall through to the WARN path below so those
  // still surface as "awaiting data" / excluded on review.
  if (
    generated.length === 0 &&
    scopedKeys.length === 0 &&
    approvedSkips > 0 &&
    missingFieldSkips === 0 &&
    excludedOutputs.length === 0
  ) {
    // The style is fully approved and this run rendered nothing. The old
    // short-circuit returned HERE — before the cover step — so the cover kept
    // whatever it last showed, rendered while these outputs were still pending
    // ("Waiting for Customer Information"). Result: an all-approved style whose
    // cover still says nothing is approved, and a re-run that never produces a
    // fresh cover (the exact IL22414 symptom).
    //
    // Fix: refresh the cover here too. `approvedBases` already holds every
    // approved base (that's WHY we short-circuited), so buildStyleCoverPdf renders
    // the manifest with each output's confirmed size. Persist it on THIS job as
    // APPROVED (the whole style is; the cover is a framing page, not a reviewable)
    // so it supersedes the stale cover and the current job owns it. Fail-soft: a
    // cover hiccup must never stop an approved style settling.
    let coverPdf: Buffer | null = null;
    try {
      coverPdf = await buildStyleCoverPdf(job.id, approvedBases);
    } catch (err) {
      await db.log
        .create({
          data: {
            jobId: job.id,
            level: "WARN",
            message: `fully-approved cover refresh failed to render: ${(err as Error).message}`,
          },
        })
        .catch(() => {});
    }
    const refreshedCoverName = coverFileName({
      styleNumber: styleData.styleNumber,
      colour: styleData.colour,
      poSeq: job.style.poSeq,
      minPo: await getSupplierSendMinPo(),
    });
    await db.$transaction([
      // This job generated no output assets, so deleteMany is a no-op for those;
      // the carried-forward approved assets live on earlier jobs and survive. We
      // then (re)create just the refreshed cover on THIS job.
      db.jobAsset.deleteMany({ where: { jobId: job.id } }),
      ...(coverPdf
        ? [
            db.jobAsset.create({
              data: {
                jobId: job.id,
                docType: "COVER",
                variantKey: COVER_VARIANT_KEY,
                displayName: "Cover page",
                fileName: refreshedCoverName,
                pdf: toPlainBytes(coverPdf),
                placeholderCount: 0,
                // Fully approved + the cover auto-ships (delivery is decoupled
                // from approval), so it lands APPROVED — no manual review of a
                // framing page, and it reads "approved" everywhere.
                reviewStatus: "APPROVED" as const,
                reviewedAt: new Date(),
              },
            }),
          ]
        : []),
      db.job.update({ where: { id: job.id }, data: { status: "APPROVED", finishedAt: new Date() } }),
      db.style.update({ where: { id: job.styleId }, data: { status: "APPROVED" } }),
      db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message:
            `no new documents generated — all ${approvedSkips} output(s) already approved and ` +
            `carried forward; ${coverPdf ? "cover refreshed to approved state, " : ""}style settled APPROVED`,
        },
      }),
    ]);
    // Hand the refreshed cover to the supplier folder (decoupled from approval —
    // the cover always ships and is re-armed on every regeneration). Fail-soft.
    if (coverPdf) {
      try {
        const cover = await db.jobAsset.findFirst({
          where: { jobId: job.id, variantKey: COVER_VARIANT_KEY },
          select: { id: true },
        });
        if (cover) {
          await enqueueCoverForSupplier(job.styleId, cover.id);
          await pushQueuedSupplierUploads({ styleIds: [job.styleId], recordRunAs: "runner" });
        }
      } catch (err) {
        console.warn(`[runner] fully-approved cover enqueue/push failed for ${job.styleId}:`, err);
      }
    }
    return;
  }

  if (generated.length === 0 && (scopedKeys.length > 0 || missingFieldSkips > 0)) {
    // A run that rendered nothing because its targeted/declared outputs had
    // their required fields missing (or a scoped target was removed/replaced),
    // or were excluded by a doc-type rule, is NOT a misconfiguration.
    // Hard-failing here would poison the auto-gen float cap and flood the logs
    // (this is what turned one orphaned-ticket bulk-fix into 90 FAILED jobs).
    // Don't fail: fall through so the cover bundle still refreshes and the job
    // settles AWAITING_REVIEW — the blocked outputs then surface as "can't
    // generate — missing X" on /reviews and the style review tab, recomputed
    // live from current Monday data. Only a FULL run with a genuine misconfig
    // (no spec / no outputs / unknown keys, below) is a real failure.
    await db.log.create({
      data: {
        jobId: job.id,
        level: "WARN",
        message:
          missingFieldSkips > 0
            ? `no outputs generated — ${missingFieldSkips} output(s) missing required fields; ` +
              `surfaced as "awaiting data" for review (cover refreshed).`
            : `scoped re-run produced no outputs — ${scopedKeys.join(", ")} no longer maps to a ` +
              `ready output in "${prodSpec?.name ?? "this spec"}"; nothing regenerated (cover refreshed).`,
      },
    });
  } else if (generated.length === 0) {
    // Three different reasons we land here — give the operator the right
    // next-action for each:
    //   (a) Style not linked to any ProdSpec     → set BusinessArea on the Style
    //   (b) ProdSpec exists but outputs is empty → add variants on /prod-specs/<id>
    //   (c) ProdSpec has outputs, all disabled / unknown variant keys
    const reason = (() => {
      if (!prodSpec) {
        return (
          "Style has no ProdSpec linked — likely missing a Business Area. " +
          "Edit the Style and set both Customer and Business Area; the ProdSpec is auto-matched by that pair."
        );
      }
      const prodSpecOutputs = Array.isArray(prodSpec.outputs) ? prodSpec.outputs : [];
      if (prodSpecOutputs.length === 0) {
        return (
          `ProdSpec "${prodSpec.name}" has no Outputs configured — open ` +
          `/prod-specs/${prodSpec.id} and use '+ Add output' to pick variants like care-label-01 / care-label-02.`
        );
      }
      return (
        `ProdSpec "${prodSpec.name}" has ${prodSpecOutputs.length} output(s) but all are disabled ` +
        `or reference unknown variant keys — check the Outputs section in /prod-specs/${prodSpec.id}.`
      );
    })();
    throw new RunnerError("NO_OUTPUTS", reason);
  }

  // Bundle framing — ONE cover document (always). When the ProdSpec carries
  // general-info markdown, those pages ride INSIDE the cover, after the cover
  // sheet — general info is never a standalone bundle PDF. Rendered AFTER the
  // outputs so the cover reflects the final generated list, persisted FIRST
  // (00- file prefix) so it opens the bundle everywhere assets are listed.
  // Placeholder-free by construction and reviewed like any other asset.
  type BundlePage = {
    docType: string;
    variantKey: string;
    displayName: string;
    fileName: string;
    pdf: Buffer;
  };
  const businessAreaName = job.style.businessAreaRef?.name ?? job.style.businessArea ?? null;
  const pageSettings = parseBundlePageSettings(prodSpec?.bundlePageSettings);
  const bundlePages: BundlePage[] = [];
  // Required-packaging manifest for the cover: EVERY declared output for this
  // style — not just what THIS run regenerated — minus the ones skipped for this
  // style (a keyword rule on the output or its type, or an operator ignore),
  // resolved through the SAME filters the render loop uses so the cover and the
  // review page agree. Each approved output shows its confirmed size; the rest
  // are flagged "Waiting for Customer Information" so the supplier expects them
  // in a later delivery.
  const coverRows = declaredEnabledOutputs.flatMap((o) => {
    const variant = resolveOutputVariant(o);
    if (!variant) return [];
    if (ignoredKeys.has(variant.key)) return [];
    const skipped = matchOutputRulesFor(
      variant.generationRules,
      exclusionRules[variant.docType],
      resolveExclusionField,
    );
    if (skipped) return [];
    const dims = effectiveOutputDims(o, variant.isInfoArea ?? false, infoAreaSizes);
    return [
      {
        variantKey: o.variantKey,
        displayName: variant.name,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        fileCount: variant.renderMany ? null : 1,
      },
    ];
  });
  // Monday's Trims entries join the declared outputs on the manifest, so the
  // supplier's list matches the buyer's. Fail-soft: a settings read that throws
  // must not fail a generation — falling back to no context yields exactly the
  // pre-Trims manifest.
  const trimContext = await loadTrimSettings()
    .then((settings) => ({ ...settings, trimLabels: resolveStyleTrimLabels(job.style) }))
    .catch(() => undefined);
  const coverDocs = assembleRequiredPackagingDocs(coverRows, approvedBases, trimContext);
  // Global cover content block (admin-authored, app-wide) — printed on the
  // cover sheet under the manifest. Fail-soft empty so a settings read never
  // breaks generation.
  const coverInfoMd = await getCoverPageInfoMd().catch(() => "");
  try {
    const generalInfoMd = prodSpec?.generalInfoMd?.trim();
    const coverPdf = await renderStyleCoverPdf(
      {
        customerName: job.style.customer.name,
        businessArea: businessAreaName,
        styleName: job.style.name,
        styleNumber: styleData.styleNumber,
        poNumber: job.style.poNumber ?? null,
        supplierName: job.style.supplier?.name ?? null,
        generatedAt: new Date(),
        docs: coverDocs,
        settings: pageSettings.cover,
        coverInfo: coverInfoMd.trim() ? { markdown: coverInfoMd } : null,
        // General info rides inside the cover document — own pages, own
        // margins, after the cover sheet. The cover is its ONLY home in the
        // bundle, so the order is guaranteed: cover sheet first, then the
        // requirements. No standalone general-information PDF is emitted.
        generalInfo: generalInfoMd
          ? { markdown: generalInfoMd, settings: pageSettings.generalInfo }
          : null,
      },
      prodSpec?.id ?? null,
    );
    bundlePages.push({
      docType: "COVER",
      variantKey: COVER_VARIANT_KEY,
      displayName: "Cover page",
      fileName: coverFileName({
        styleNumber: styleData.styleNumber,
        colour: styleData.colour,
        poSeq: job.style.poSeq,
        minPo: await getSupplierSendMinPo(),
      }),
      pdf: coverPdf,
    });
  } catch (err) {
    throw new RunnerError(
      "BUNDLE_PAGES_FAILED",
      `cover/general-info page render failed: ${(err as Error).message}`,
    );
  }

  // Auto-approve resolution. A generated doc skips the manual review queue
  // (reviewStatus APPROVED at creation) when EITHER its OutputLayout has
  // autoApprove = true OR its ProdSpec is marked "Fully approved" (a spec-wide
  // trust flag the admin sets on /prod-specs; it also feeds the toggle's
  // approve-and-rerun flow) — BUT only when print-safe: a doc carrying
  // placeholder artifacts always falls back to manual review (mirrors the
  // ship-gate in the approve route + publishApprovedJob). The spec-level gate
  // is deliberately broader than the per-layout one: it covers coded-template
  // outputs too, since "Fully approved" means the whole spec is trusted.
  // Bundle pages (cover / general info) are never auto-approved — they're
  // cascaded by the human "Approve all & publish" send, which is the manual
  // checkpoint we deliberately keep. Delivery (SharePoint + supplier email) is
  // NOT triggered here; auto-approve removes the review click, not the send.
  const specFullyApproved = prodSpec?.fullyApproved === true;
  const generatedLayoutIds = [
    ...new Set(generated.map((d) => layoutIdFromVariantKey(d.variantKey)).filter((x): x is string => x !== null)),
  ];
  const autoApproveLayoutIds = new Set(
    generatedLayoutIds.length > 0
      ? (
          await db.outputLayout.findMany({
            where: { id: { in: generatedLayoutIds }, autoApprove: true },
            select: { id: true },
          })
        ).map((l) => l.id)
      : [],
  );
  const isAutoApproved = (doc: (typeof generated)[number]): boolean => {
    if (doc.placeholderCount !== 0) return false;
    if (specFullyApproved) return true;
    const layoutId = layoutIdFromVariantKey(doc.variantKey);
    return layoutId !== null && autoApproveLayoutIds.has(layoutId);
  };
  const autoApprovedAt = new Date();
  const autoApprovedDocs = generated.filter(isAutoApproved);

  // Review continuity: if this run supersedes a review that was already
  // underway (claimed, or a human had decided ≥1 document), carry that owner
  // onto the new job — a regen swaps the PDFs, it doesn't un-start the
  // review. Keeps the style in /reviews "In Progress" (and the right
  // person's "Mine" bucket) instead of dropping back to the untouched queue.
  const carriedClaim = await findCarryForwardClaim(job.styleId, job.id);

  try {
    await db.$transaction([
      db.jobAsset.deleteMany({ where: { jobId: job.id } }),
      ...bundlePages.map((p) =>
        db.jobAsset.create({
          data: {
            jobId: job.id,
            docType: p.docType,
            variantKey: p.variantKey,
            displayName: p.displayName,
            fileName: p.fileName,
            pdf: toPlainBytes(p.pdf),
            placeholderCount: 0,
          },
        }),
      ),
      ...generated.map((doc) =>
        db.jobAsset.create({
          data: {
            jobId: job.id,
            docType: doc.variant.docType,
            variantKey: doc.variantKey,
            displayName: doc.displayName,
            fileName: doc.fileName,
            pdf: toPlainBytes(doc.pdf),
            placeholderCount: doc.placeholderCount,
            // Fingerprint of the output's render-affecting config (dims / pins /
            // carton / size) + the layout's published version, so the rerun
            // surfaces can tell an edited output apart from an untouched one.
            outputConfigKey: outputConfigKey(doc.output),
            outputContentVersion: doc.variant.contentVersion ?? null,
            // System auto-approval — reviewedById left null marks "no human
            // reviewer" (vs. the session user the approve route stamps).
            ...(isAutoApproved(doc)
              ? { reviewStatus: "APPROVED" as const, reviewedAt: autoApprovedAt }
              : {}),
          },
        }),
      ),
      db.job.update({
        where: { id: job.id },
        data: {
          status: "AWAITING_REVIEW",
          finishedAt: new Date(),
          ...(carriedClaim
            ? { reviewClaimedById: carriedClaim.userId, reviewClaimedAt: carriedClaim.at }
            : {}),
        },
      }),
      db.style.update({
        where: { id: job.styleId },
        data: { status: "AWAITING_REVIEW" },
      }),
      // A FULL re-run is a fresh review round: the whole style regenerated, so
      // every prior open rejection ticket is superseded and moves to history in
      // the same commit as the asset swap. Scoped/partial runs (ticket re-runs,
      // carton customize, auto-sweeps) carry variantKeys and skip this — they
      // only ever touched the outputs they targeted.
      ...(scopedKeys.length === 0 ? [supersedeOpenTicketsForStyleOp(job.styleId)] : []),
      db.log.create({
        data: {
          jobId: job.id,
          level: "INFO",
          message:
            `generated ${generated.length} documents (${generated.map((d) => d.variant.key).join(", ")})` +
            (autoApprovedDocs.length > 0
              ? ` · auto-approved ${autoApprovedDocs.length} (${autoApprovedDocs
                  .map((d) => d.variant.key)
                  .join(", ")}) — skipped manual review, still pending supplier send`
              : ""),
        },
      }),
    ]);
  } catch (err) {
    throw new RunnerError("PERSIST_FAILED", `persisting assets failed: ${(err as Error).message}`);
  }

  // Auto-approved docs skip the manual review queue, so capture them into the
  // supplier-send queue here (the manual path captures at approve time). WS2 —
  // fail-soft, always runs; the queue only records intent, never sends.
  try {
    await enqueueApprovedAssetsForJob(job.id);
  } catch (err) {
    console.warn(`[supplier-send-queue] runner enqueue failed for ${job.id}:`, err);
  }

  // The cover is a framing MANIFEST, not a reviewable layout — it ships to the
  // supplier folder regardless of approval and is re-armed on EVERY regeneration
  // so the folder always holds the current one (the layouts still gate on
  // approval above). Arm this run's cover here, before the push below, so it
  // lands in the same pass. Fail-soft; no-op for styles with no supplier /
  // skipSupplierDelivery.
  try {
    const coverAsset = await db.jobAsset.findFirst({
      where: { jobId: job.id, variantKey: COVER_VARIANT_KEY },
      select: { id: true },
    });
    if (coverAsset) {
      // Fingerprint of the manifest this run actually printed. Without it a
      // freshly generated cover looks "unknown" to the regen sweep and gets
      // rebuilt once for nothing.
      await db.jobAsset
        .update({
          where: { id: coverAsset.id },
          data: { coverManifestKey: manifestFingerprint(coverDocs) },
        })
        .catch(() => {});
      await enqueueCoverForSupplier(job.styleId, coverAsset.id);
    }
  } catch (err) {
    console.warn(`[supplier-send-queue] runner cover enqueue failed for ${job.id}:`, err);
  }

  // …and land them in the supplier's own SharePoint folder like a manual
  // approval would (flag-gated + fail-soft inside the lib; the midnight sweep
  // retries anything that failed here).
  try {
    await pushQueuedSupplierUploads({ styleIds: [job.styleId], recordRunAs: "runner" });
  } catch (err) {
    console.warn(`[supplier-upload] runner push failed for ${job.id}:`, err);
  }

  // A scoped no-op run (nothing generated, only the cover refreshed — see the
  // scoped-empty branch above) must not ping reviewers with a "0 documents"
  // notice. Real runs (≥1 generated doc) notify as before.
  if (generated.length > 0) {
    await notifyReviewer({
      jobId: job.id,
      styleId: job.styleId,
      styleName: job.style.name,
      styleNumber: styleData.styleNumber,
      customerName: job.style.customer.name,
      businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
      poNumber: job.style.poNumber ?? null,
      triggerSource: job.triggerSource,
      outputNames: generated.map(
        (d) => `${d.variant.name} · ${d.output.widthMm}×${d.output.heightMm} mm`,
      ),
    });
  }
}

async function notifyReviewer(input: {
  jobId: string;
  styleId: string;
  styleName: string;
  styleNumber: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  triggerSource: TriggerSource;
  outputNames: string[];
}): Promise<void> {
  // Ticket-driven runs stay silent: TICKET_RERUN is the admin iterating on
  // a fix (the reviewer must not be pinged per attempt) and TICKET_FIX
  // sends its own dedicated "fixed — ready for re-review" email from the
  // fix endpoint, with the rejection context the generic mail lacks.
  if (input.triggerSource === "TICKET_RERUN" || input.triggerSource === "TICKET_FIX") return;

  // Reviewers are no longer emailed when outputs finish generating — the only
  // outbound mail is the nightly supplier digest. The in-app review-inbox entry
  // below keeps the work visible without a mailbox blast; the recipient list
  // still decides who gets that in-app notice.
  const recipients = await getReviewNotificationEmails();

  // In-app review-ready notice (T2): ADMINs get the entry — they own the
  // pipeline and triage the queue — plus any configured recipient with an
  // account. REVIEWERs are deliberately excluded (a fresh output in the queue
  // isn't theirs to act on until they pick it up; they work from /reviews and
  // reviews they've started). Fires even when the email was SIMULATED/SKIPPED
  // (the work exists either way). The href carries ?claim=1 so opening the
  // review FROM the notice claims it and starts the timer (reviewClaimedAt);
  // see styles/[id]/review/claim-review.tsx. Fail-soft inside the helper;
  // auto-resolved when the job settles.
  await notifyReviewReady(recipients, {
    type: "REVIEW_READY",
    title: "Documents ready for review",
    body: [
      input.styleName,
      input.customerName,
      input.poNumber ? `PO ${input.poNumber}` : null,
      `${input.outputNames.length} document${input.outputNames.length === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · "),
    href: `/styles/${input.styleId}/review?claim=1`,
    jobId: input.jobId,
    styleId: input.styleId,
  });
}

async function markFailed(jobId: string, error: string): Promise<void> {
  // Print to stderr too — `next dev` only shows the prisma query stream by
  // default, so otherwise the actual exception never reaches the terminal.
  console.error(`[runner] job ${jobId} FAILED: ${error}`);
  const job = await db.job.update({
    where: { id: jobId },
    data: { status: "FAILED", error, finishedAt: new Date() },
    select: { styleId: true },
  });
  await db.log.create({ data: { jobId, level: "ERROR", message: `job failed: ${error}` } });

  // A failed render must not strand the style in GENERATING — bulk-run flips the
  // style to GENERATING before enqueue (see bulk-run.ts), and the success path
  // moves it to AWAITING_REVIEW, but a failure used to leave it stuck there
  // forever (the sweep skips GENERATING styles). Reset to a pre-generation
  // status so it can be retried; the 3-strike float cap is the backstop against
  // a perpetually-failing render. Only touch GENERATING — never downgrade a
  // style that already moved on.
  const style = await db.style.findUnique({
    where: { id: job.styleId },
    select: { status: true, completionPct: true },
  });
  if (style?.status === "GENERATING") {
    await db.style.update({
      where: { id: job.styleId },
      data: { status: style.completionPct === 100 ? "READY" : "PENDING" },
    });
  }
}

export class RunnerError extends Error {
  constructor(public readonly tag: string, message: string) {
    super(`[${tag}] ${message}`);
    this.name = "RunnerError";
  }
}

function fileNameFor(variant: TemplateVariant, styleNumber: string): string {
  return defaultArtifactFileName(variant, styleNumber);
}
