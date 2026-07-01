import { db } from "@/lib/db";
import { renderPdf } from "@/lib/pdf/renderer";
import { inlineProdSpecImages } from "@/lib/pdf/inline-images";
import { ensureLayoutVariantsLoaded, layoutIdFromVariantKey } from "@/lib/output-layouts/variants";
import { buildStyleData } from "@/lib/styles/render-context";
import { outputReadinessForStyle, effectiveMapping } from "@/lib/styles/output-readiness";
import { effectiveStyleItem, resolveMappedField } from "@/lib/styles/resolved-fields";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { matchExclusionRules, exclusionReasonText } from "@/lib/outputs/exclusion";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { applyCartonBarcodePrefs, applyFieldOverrides } from "@/lib/pdf/pins";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";
import type { StyleData } from "@/lib/pdf/types";
import { defaultArtifactFileName, type TemplateVariant } from "@/lib/pdf/template-registry";
import { dispatchEmail } from "@/lib/email/dispatch";
import { reviewNotificationEmail } from "@/lib/email/templates/review-notification";
import { notifyReviewReady } from "@/lib/notifications/user-notifications";
import { supersedeOpenTicketsForStyleOp } from "@/lib/tickets/rejection-tickets";
import { getReviewNotificationEmails } from "@/lib/settings/app-settings";
import {
  COVER_VARIANT_KEY,
  GENERAL_INFO_VARIANT_KEY,
  renderCoverPageHtml,
  type BundleDocSummary,
} from "@/lib/pdf/bundle-pages";
import type { TriggerSource } from "@/generated/prisma/enums";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import {
  DEFAULT_OUTPUTS,
  parseBundlePageSettings,
  parseProdSpecOutputs,
  resolveOutputVariant,
  type ProdSpecOutput,
} from "@/lib/prod-spec/config";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { enqueueApprovedAssetsForJob } from "@/lib/publish/supplier-send-queue";

const STALE_RUNNING_MS = 15 * 60 * 1000;

function toPlainBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

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

export async function processJob(jobId: string): Promise<void> {
  // Load published Output Builder layouts into the variant registry so
  // `layout:<id>` keys resolve like any code-registered variant below
  // (resolveOutputVariant / outputReadinessForStyle are sync lookups).
  await ensureLayoutVariantsLoaded();

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      style: {
        include: {
          customer: true,
          qrImage: true,
          // Country feeds render fallbacks; name prints on the cover page.
          supplier: { select: { country: true, name: true } },
          // Display name for the review-ready email (falls back to the
          // free-text Style.businessArea when the mirror row isn't linked).
          businessAreaRef: { select: { name: true } },
          // Resolved PO barcodes — fall back into the ean13/cartonEan
          // fields at render time (see effectiveStyleItem).
          eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, variantLabel: true } },
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
  const readyKeys = new Set(
    (prodSpec
      ? outputReadinessForStyle({
          rawData: job.style.rawData,
          poNumber: job.style.poNumber,
          supplier: job.style.supplier,
          eans: job.style.eans,
          cartonEan: job.style.cartonEan,
          customer: { config: job.style.customer.config },
          prodSpec: { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping },
        })
      : []
    )
      .filter((r) => r.ready)
      .map((r) => r.variantKey),
  );

  // Scoped re-runs (auto-enqueue / ticket fixes) narrow to specific outputs;
  // an empty scope is a full regen of every enabled output. Tickets reference
  // per-document asset keys ("layout:<id>#<size>"); ProdSpec outputs carry the
  // BASE key — match on the base so a per-document rejection re-runs its whole
  // variant.
  if (scopedKeys.length > 0) {
    const want = new Set(scopedKeys.map((k) => k.split("#")[0]));
    outputs = outputs.filter((o) => want.has(o.variantKey));
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
  // One row per OUTPUT (not per file) for the cover page's documents
  // table — title + dims once, with a file count for multi-doc variants.
  const docSummaries: BundleDocSummary[] = [];
  // Info-area size catalogue, loaded once — resolves each info-area
  // output's per-style size pick to printed mm. Empty if the migration
  // isn't applied yet; outputs then fall back to their stored dims.
  const infoAreaSizes = await loadInfoAreaSizeMap();

  // Output-exclusion: a doc-type keyword rule can skip EVERY output of that
  // type for this style (e.g. socks/shoes → no wash-care). Resolved through the
  // SAME field resolver readiness/render use, so the runner and the review page
  // can never disagree on what's skipped. Empty before db:deploy ⇒ nothing
  // excluded. `excludedOutputs` lets us tell "all outputs intentionally
  // skipped" apart from a real misconfiguration below.
  const exclusionRules = await loadDocTypeExclusionRules();
  const exclusionActive = Object.keys(exclusionRules).length > 0;
  const exclusionLabels = exclusionActive ? await loadDocTypeLabels() : {};
  const resolveExclusionField: ((field: string) => string) | null = exclusionActive
    ? (() => {
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
      })()
    : null;
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
    // Doc-type keyword exclusion — skip (don't render) and record WHY, so the
    // review surfaces an "Excluded" reason instead of a perpetual "awaiting".
    if (resolveExclusionField) {
      const hit = matchExclusionRules(exclusionRules[variant.docType], resolveExclusionField);
      if (hit) {
        const reason = exclusionReasonText(hit, docTypeLabel(variant.docType, exclusionLabels));
        excludedOutputs.push(variant.key);
        await db.log.create({
          data: { jobId: job.id, level: "INFO", message: `skipping output ${variant.key}: ${reason}` },
        });
        continue;
      }
    }
    try {
      // Per-output pins ("customerName is ALWAYS …") and the carton barcode
      // preference applied on a copy — the base StyleData is shared across
      // this job's outputs. Standard generation is always SINGLE-style:
      // multi-style carton marking is a manual one-off (the carton dialog),
      // never standing config, so the runner never flips style.multipleStyles
      // and {{style2}}+ stay empty here.
      const renderStyle = applyCartonBarcodePrefs(
        applyFieldOverrides(styleData, output.fieldOverrides),
        output,
      );
      // Printed size — the info-area size override (admin pick or custom)
      // when the variant is an info area, else the output's own dims.
      const dims = effectiveOutputDims(output, variant.isInfoArea ?? false, infoAreaSizes);
      // Static-pdf passthrough variants emit their source artwork bytes
      // verbatim; everything else renders HTML → PDF.
      if (!variant.staticPdf && variant.renderMany) {
        // Multi-document variant: one PDF per returned doc, each its own
        // JobAsset under "<key>#<suffix>".
        const docs = await variant.renderMany(renderStyle, dims);
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
        docSummaries.push({
          displayName: variant.name,
          widthMm: dims.widthMm,
          heightMm: dims.heightMm,
          fileCount: docs.length,
        });
        continue;
      }

      let pdf: Buffer;
      let placeholderCount = 0;
      if (variant.staticPdf) {
        pdf = await variant.staticPdf();
      } else {
        const html = await variant.render(renderStyle, dims);
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
      docSummaries.push({
        displayName: variant.name,
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        fileCount: 1,
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
  const slug = styleSlug(styleData.styleNumber);
  const pageSettings = parseBundlePageSettings(prodSpec?.bundlePageSettings);
  const bundlePages: BundlePage[] = [];
  try {
    const generalInfoMd = prodSpec?.generalInfoMd?.trim();
    let coverHtml = renderCoverPageHtml({
      customerName: job.style.customer.name,
      businessArea: businessAreaName,
      styleName: job.style.name,
      styleNumber: styleData.styleNumber,
      poNumber: job.style.poNumber ?? null,
      supplierName: job.style.supplier?.name ?? null,
      generatedAt: new Date(),
      docs: docSummaries,
      settings: pageSettings.cover,
      // General info rides inside the cover document — own pages, own
      // margins, after the cover sheet. The cover is its ONLY home in the
      // bundle, so the order is guaranteed: cover sheet first, then the
      // requirements. No standalone general-information PDF is emitted.
      generalInfo: generalInfoMd
        ? { markdown: generalInfoMd, settings: pageSettings.generalInfo }
        : null,
    });
    // Resolve general-info image URLs to data URLs — the cover embeds the
    // same markdown, and page.setContent() can't fetch a bare /api path.
    if (prodSpec && generalInfoMd) coverHtml = await inlineProdSpecImages(coverHtml, prodSpec.id);
    bundlePages.push({
      docType: "COVER",
      variantKey: COVER_VARIANT_KEY,
      displayName: "Cover page",
      fileName: `00-${slug}-cover-page.pdf`,
      pdf: await renderPdf({ html: coverHtml }),
    });
  } catch (err) {
    throw new RunnerError(
      "BUNDLE_PAGES_FAILED",
      `cover/general-info page render failed: ${(err as Error).message}`,
    );
  }

  // Auto-approve resolution. A generated doc skips the manual review queue
  // (reviewStatus APPROVED at creation) when its OutputLayout has
  // autoApprove = true — BUT only when print-safe: a doc carrying
  // placeholder artifacts always falls back to manual review (mirrors the
  // ship-gate in the approve route + publishApprovedJob). Bundle pages
  // (cover / general info) are never auto-approved — they're cascaded by the
  // human "Approve all & publish" send, which is the manual checkpoint we
  // deliberately keep. Delivery (SharePoint + supplier email) is NOT
  // triggered here; auto-approve removes the review click, not the send.
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
    const layoutId = layoutIdFromVariantKey(doc.variantKey);
    return layoutId !== null && autoApproveLayoutIds.has(layoutId) && doc.placeholderCount === 0;
  };
  const autoApprovedAt = new Date();
  const autoApprovedDocs = generated.filter(isAutoApproved);

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
        data: { status: "AWAITING_REVIEW", finishedAt: new Date() },
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

  // Cron-origin generation (the PO→EAN handoff and the backlog sweep) and the
  // admin "Run all outputs" bulk action never send the review-ready EMAIL —
  // automated / many-at-once fills shouldn't blast the mailbox — but still drop
  // the in-app review-inbox entry below so the work stays visible. Holds even
  // if email is re-enabled for manual/webhook runs.
  const emailSuppressed =
    input.triggerSource === "EAN_RESOLVED" ||
    input.triggerSource === "CRON_SWEEP" ||
    input.triggerSource === "MANUAL_BULK";

  const recipients = await getReviewNotificationEmails();

  if (!emailSuppressed) {
    const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
    const reviewUrl = `${base}/styles/${input.styleId}/review`;
    const email = reviewNotificationEmail({
      styleName: input.styleName,
      styleNumber: input.styleNumber,
      customerName: input.customerName,
      businessArea: input.businessArea,
      poNumber: input.poNumber,
      reviewUrl,
      outputNames: input.outputNames,
    });

    try {
      // Empty recipients still dispatch: that records a SKIPPED email_logs
      // row with an actionable note instead of silently notifying no one.
      const outcome = await dispatchEmail({
        type: "REVIEW_READY",
        to: recipients,
        subject: email.subject,
        html: email.html,
        text: email.text,
        jobId: input.jobId,
        styleId: input.styleId,
      });
      const message =
        outcome.status === "SENT"
          ? `review notification sent to ${outcome.to}`
          : outcome.status === "SIMULATED"
            ? `review notification SIMULATED (RESEND_EMAILS off) — would go to ${outcome.to}`
            : outcome.status === "FAILED"
              ? `review notification FAILED: ${outcome.note ?? "Resend error"}`
              : `review notification skipped: ${outcome.note ?? "no recipient — set it at /settings/notifications"}`;
      await db.log.create({
        data: { jobId: input.jobId, level: outcome.status === "FAILED" ? "WARN" : "INFO", message },
      });
    } catch (err) {
      await db.log.create({
        data: { jobId: input.jobId, level: "WARN", message: `review notification failed: ${(err as Error).message}` },
      });
    }
  }

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

// Still used by the bundle-page naming below; per-variant artifact names
// come from the registry so the pre-run files preview can't drift.
function styleSlug(styleNumber: string): string {
  return styleNumber.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

function fileNameFor(variant: TemplateVariant, styleNumber: string): string {
  return defaultArtifactFileName(variant, styleNumber);
}
