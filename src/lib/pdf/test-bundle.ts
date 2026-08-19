import { db } from "@/lib/db";
import { renderPdf } from "@/lib/pdf/renderer";
import { inlineProdSpecImages } from "@/lib/pdf/inline-images";
import { inlineCoverPageImages } from "@/lib/pdf/inline-cover-images";
import { getCoverPageInfoMd } from "@/lib/settings/app-settings";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildStyleData } from "@/lib/styles/render-context";
import { applyCartonBarcodePrefs, applyFieldOverrides } from "@/lib/pdf/pins";
import {
  ignoreBaseKey,
  loadStyleFieldValues,
  mergeFieldOverrides,
} from "@/lib/outputs/output-field-values";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";
import { defaultArtifactFileName } from "@/lib/pdf/template-registry";
import { COVER_VARIANT_KEY, renderCoverPageHtml } from "@/lib/pdf/bundle-pages";
import { buildRequiredPackagingForStyle } from "@/lib/outputs/required-packaging";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { exclusionReasonText, matchOutputRulesFor } from "@/lib/outputs/exclusion";
import { effectiveStyleItem, resolveMappedField } from "@/lib/styles/resolved-fields";
import { effectiveMapping } from "@/lib/styles/output-readiness";
import {
  DEFAULT_OUTPUTS,
  parseBundlePageSettings,
  parseProdSpecOutputs,
  resolveOutputVariant,
  type ProdSpecOutput,
} from "@/lib/prod-spec/config";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import { coverFileName } from "./cover-file-name";
import { getSupplierSendMinPo } from "@/lib/settings/app-settings";

// =====================================================
// Test-bundle renderer — a DRY RUN of the job runner.
//
// Renders the exact PDFs a real generation would produce for ONE chosen
// style under a prod spec — the cover (with general information appended
// inside it, runner-identical) plus one PDF per enabled output — but
// creates NO Job, NO JobAssets, NO review tasks and notifies NO ONE. It
// feeds the /prod-specs/<id> "Test" tab so an operator can eyeball every
// document before committing to an actual rerun.
//
// The render path mirrors src/lib/queue/runner.ts#processJob deliberately:
// same buildStyleData assembly, same output resolution + dims + pins +
// carton prefs, same renderMany / static-pdf handling, same cover framing,
// and the same generation-rule gate (an output the runner would skip is
// skipped here too, with the reason surfaced as a warning). Keep the two in
// sync — if the runner's render loop changes, change this loop too.
//
// TWO intentional divergences:
//   • A single output that fails to render becomes an error card here (so the
//     operator sees WHICH output is broken) instead of failing the whole
//     bundle the way a job would.
//   • Per-style operator ignores are NOT applied — a test renders an output
//     the operator has ignored for this one style, so it can still be
//     previewed. Keyword RULES are applied; a per-style ignore is a manual
//     choice the operator can undo, not a property of the configuration.
// =====================================================

export type TestBundleDoc = {
  kind: "cover" | "output";
  // Variant key (synthetic COVER_VARIANT_KEY for the cover), suffixed
  // "#<part>" for one file of a multi-document (repeat-per-EAN) output.
  variantKey: string;
  // Human label for the card header.
  name: string;
  // Suggested download name; null when the doc errored.
  fileName: string | null;
  widthMm: number;
  heightMm: number;
  // Static-pdf passthrough output (committed artwork shipped verbatim).
  staticPdf: boolean;
  // Placeholder artifacts found in the rendered HTML (missing artwork /
  // "No carton EAN" tiles). Non-zero blocks approval on a real run — shown
  // as a loud badge here so the test surfaces it too. 0 for static / errors.
  placeholderCount: number;
  // Rendered PDF bytes; null when this doc failed to render (see `error`).
  pdf: Buffer | null;
  // Per-doc render error — resilient: one bad output never sinks the rest.
  error: string | null;
};

export type TestBundleResult = {
  style: {
    id: string;
    name: string;
    styleNumber: string;
    poNumber: string | null;
  };
  docs: TestBundleDoc[];
  // Non-fatal notes (e.g. an output referencing a stale variant key that
  // was skipped) — surfaced to the operator above the document list.
  warnings: string[];
};

// Render the full test bundle for (prodSpec × style). Throws only on
// caller errors (missing rows, mismatched ownership); per-document render
// failures are captured into the returned docs as error cards.
export async function renderProdSpecTestBundle(
  prodSpecId: string,
  styleId: string,
): Promise<TestBundleResult> {
  // Published Output Builder layouts must be in the registry before any
  // `layout:<id>` key resolves — same first step the runner takes.
  await ensureLayoutVariantsLoaded();

  // Load the style with the SAME include shape the runner uses, so the
  // assembled StyleData is byte-for-byte what a real job would build.
  const style = await db.style.findUnique({
    where: { id: styleId },
    include: {
      customer: true,
      qrImage: true,
      supplier: { select: { country: true, name: true } },
      businessAreaRef: { select: { name: true } },
      eans: {
        orderBy: { position: "asc" },
        select: { size: true, ean13: true, variantLabel: true, cartonEan: true, excluded: true },
      },
    },
  });
  if (!style) throw new TestBundleError("Style not found");
  // Guard: the picker only offers this spec's styles, but never trust the
  // query param — a style's outputs/dims come from THIS prod spec.
  if (style.prodSpecId !== prodSpecId) {
    throw new TestBundleError("That style is not linked to this prod spec");
  }

  const prodSpec = await db.prodSpec.findUnique({ where: { id: prodSpecId } });
  if (!prodSpec) throw new TestBundleError("Prod spec not found");

  const warnings: string[] = [];

  let config;
  try {
    config = parseCustomerConfig(style.customer.config);
  } catch (err) {
    throw new TestBundleError(`Customer config invalid: ${(err as Error).message}`);
  }

  const styleData = await buildStyleData(
    {
      id: style.id,
      rawData: style.rawData,
      poNumber: style.poNumber,
      cartonEan: style.cartonEan,
      mondayBoardId: style.mondayBoardId,
      supplier: style.supplier,
      eans: style.eans,
      customer: { name: style.customer.name, config: style.customer.config },
      qrImage: style.qrImage ? { image: style.qrImage.image } : null,
    },
    prodSpec,
    config,
  );

  // Outputs: the prod spec's enabled outputs (the operator's explicit
  // pick), falling back to DEFAULT_OUTPUTS for an unconfigured spec — the
  // same selection rule the runner applies. No per-output scoping: a test
  // always renders the full enabled set.
  const outputs: ProdSpecOutput[] = (() => {
    const parsed = parseProdSpecOutputs(prodSpec.outputs);
    const enabled = parsed.filter((o) => o.enabled !== false);
    return enabled.length > 0 ? enabled : DEFAULT_OUTPUTS;
  })();

  const infoAreaSizes = await loadInfoAreaSizeMap();
  // Per-style inline field values — merged with each output's pins below so the
  // test bundle mirrors what the runner would generate. Fail-soft empty.
  const fieldValues = await loadStyleFieldValues(styleId);

  // Generation rules — an output's own ("only for shoes", the layout's Settings
  // tab) or its DOC TYPE's ("shoes skip wash care"). The runner skips these
  // outright, so a dry run that rendered them anyway would show the operator
  // documents that can never be produced. Same loader + same field resolver as
  // runner.ts#processJob, so the two can't disagree about what is skipped.
  //
  // NOTE: per-style operator ignores (loadIgnoredOutputKeys) are a SEPARATE
  // gate the runner also applies; a test still renders those deliberately, so
  // an operator can preview an output they've ignored for this one style.
  const [exclusionRules, exclusionLabels] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
  ]);
  const resolveExclusionField: (field: string) => string = (() => {
    const rStyle = {
      rawData: style.rawData,
      poNumber: style.poNumber,
      supplier: style.supplier,
      eans: style.eans,
      cartonEan: style.cartonEan,
      customer: { config: style.customer.config },
      prodSpec: { outputs: prodSpec.outputs, columnMapping: prodSpec.columnMapping },
    };
    const item = effectiveStyleItem(rStyle);
    const mapping = effectiveMapping(rStyle);
    return (f: string) => resolveMappedField(item, mapping, f as keyof ColumnMapping);
  })();

  const outputDocs: TestBundleDoc[] = [];

  for (const output of outputs) {
    const variant = resolveOutputVariant(output);
    if (!variant) {
      warnings.push(
        `Output "${output.variantKey}" was skipped — it is no longer in the variant registry (a removed template or unpublished layout).`,
      );
      continue;
    }
    // Skip exactly what the runner would skip, and say why — the reason text is
    // the same string the style/review surfaces show, naming the OUTPUT for its
    // own rule or the document TYPE for a type-level one.
    const decided = matchOutputRulesFor(
      variant.generationRules,
      exclusionRules[variant.docType],
      resolveExclusionField,
    );
    if (decided) {
      warnings.push(
        `${variant.name} — ${exclusionReasonText(
          decided.hit,
          decided.scope === "output"
            ? variant.name
            : docTypeLabel(variant.docType, exclusionLabels),
        )}`,
      );
      continue;
    }
    try {
      // Per-output pins ∪ this style's inline field values (per-style wins) +
      // carton barcode preference on a copy; the base StyleData is shared across
      // this style's outputs (runner-identical).
      const baseKey = ignoreBaseKey(output.variantKey, variant.docType);
      const renderStyle = applyCartonBarcodePrefs(
        applyFieldOverrides(styleData, mergeFieldOverrides(output.fieldOverrides, fieldValues.get(baseKey))),
        output,
      );
      // Per-PDF overrides ("<base>#<suffix>") for a multi-doc output — mirrors
      // the runner so a Test-tab dry run matches production per document.
      const docPrefix = `${baseKey}#`;
      const perDocOverrides = new Map<string, Record<string, string>>();
      for (const [k, v] of fieldValues) {
        if (k.startsWith(docPrefix)) perDocOverrides.set(k.slice(docPrefix.length), v as Record<string, string>);
      }
      // Printed size: info-area size override when applicable, else the
      // output's own dims.
      const dims = effectiveOutputDims(output, variant.isInfoArea ?? false, infoAreaSizes);

      // Multi-document variant (Output Builder repeat-per-EAN): one PDF per
      // returned doc.
      if (!variant.staticPdf && variant.renderMany) {
        const parts = await variant.renderMany(
          renderStyle,
          dims,
          perDocOverrides.size > 0 ? perDocOverrides : undefined,
        );
        for (const doc of parts) {
          const defaultName = defaultArtifactFileName(variant, styleData.styleNumber).replace(
            /\.pdf$/,
            `-${doc.suffix}.pdf`,
          );
          outputDocs.push({
            kind: "output",
            variantKey: parts.length > 1 ? `${variant.key}#${doc.suffix}` : variant.key,
            name: parts.length > 1 ? `${variant.name} · ${doc.suffix}` : variant.name,
            fileName: doc.fileName ?? defaultName,
            widthMm: dims.widthMm,
            heightMm: dims.heightMm,
            staticPdf: false,
            placeholderCount: countPlaceholderMarkers(doc.html),
            pdf: await renderPdf({ html: doc.html }),
            error: null,
          });
        }
        continue;
      }

      // Single-document variant — static-pdf passthrough or HTML → PDF.
      let pdf: Buffer;
      let placeholderCount = 0;
      if (variant.staticPdf) {
        pdf = await variant.staticPdf();
      } else {
        const html = await variant.render(renderStyle, dims);
        placeholderCount = countPlaceholderMarkers(html);
        pdf = await renderPdf({ html });
      }
      outputDocs.push({
        kind: "output",
        variantKey: variant.key,
        name: variant.name,
        fileName:
          variant.fileNameFor?.(renderStyle) ??
          defaultArtifactFileName(variant, styleData.styleNumber),
        widthMm: dims.widthMm,
        heightMm: dims.heightMm,
        staticPdf: Boolean(variant.staticPdf),
        placeholderCount,
        pdf,
        error: null,
      });
    } catch (err) {
      // Resilient: surface the broken output as a card, keep going.
      outputDocs.push({
        kind: "output",
        variantKey: variant.key,
        name: variant.name,
        fileName: null,
        widthMm: output.widthMm,
        heightMm: output.heightMm,
        staticPdf: Boolean(variant.staticPdf),
        placeholderCount: 0,
        pdf: null,
        error: (err as Error).message,
      });
    }
  }

  // Cover (with general information appended inside it) — rendered AFTER
  // the outputs so its document table reflects the final list, presented
  // FIRST so it opens the bundle. Runner-identical framing.
  const businessAreaName = style.businessAreaRef?.name ?? style.businessArea ?? null;
  const pageSettings = parseBundlePageSettings(prodSpec.bundlePageSettings);
  const generalInfoMd = prodSpec.generalInfoMd?.trim();
  const coverInfoMd = (await getCoverPageInfoMd().catch(() => "")).trim();
  let coverDoc: TestBundleDoc;
  try {
    let coverHtml = renderCoverPageHtml({
      customerName: style.customer.name,
      businessArea: businessAreaName,
      styleName: style.name,
      styleNumber: styleData.styleNumber,
      poNumber: style.poNumber ?? null,
      supplierName: style.supplier?.name ?? null,
      generatedAt: new Date(),
      // The required-packaging manifest with live approval state (dry run
      // against a real style) — same builder the publish cover uses.
      docs: await buildRequiredPackagingForStyle(styleId),
      settings: pageSettings.cover,
      generalInfo: generalInfoMd
        ? { markdown: generalInfoMd, settings: pageSettings.generalInfo }
        : null,
      coverInfo: coverInfoMd ? { markdown: coverInfoMd } : null,
    });
    // Inline image URLs to data URLs — page.setContent() can't fetch a bare
    // /api path (same as the runner + cover preview). General-info images are
    // ProdSpec-owned; the global cover block's are addressed globally.
    if (generalInfoMd) coverHtml = await inlineProdSpecImages(coverHtml, prodSpec.id);
    if (coverInfoMd) coverHtml = await inlineCoverPageImages(coverHtml);
    coverDoc = {
      kind: "cover",
      variantKey: COVER_VARIANT_KEY,
      name: generalInfoMd ? "Cover page · incl. general information" : "Cover page",
      fileName: coverFileName({
        styleNumber: styleData.styleNumber,
        colour: styleData.colour,
        poSeq: style.poSeq,
        minPo: await getSupplierSendMinPo(),
      }),
      widthMm: 210,
      heightMm: 297,
      staticPdf: false,
      placeholderCount: 0,
      pdf: await renderPdf({ html: coverHtml }),
      error: null,
    };
  } catch (err) {
    coverDoc = {
      kind: "cover",
      variantKey: COVER_VARIANT_KEY,
      name: "Cover page",
      fileName: null,
      widthMm: 210,
      heightMm: 297,
      staticPdf: false,
      placeholderCount: 0,
      pdf: null,
      error: (err as Error).message,
    };
  }

  return {
    style: {
      id: style.id,
      name: style.name,
      styleNumber: styleData.styleNumber,
      poNumber: style.poNumber ?? null,
    },
    // Order mirrors the runner's bundle assets: 00 cover (general info rides
    // inside it), then the outputs.
    docs: [coverDoc, ...outputDocs],
    warnings,
  };
}

// Caller-error sentinel — the route maps this to a 400/404 with the
// message, vs. an unexpected 500 for anything else.
export class TestBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestBundleError";
  }
}
