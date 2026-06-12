import { allVariants, TEMPLATE_VARIANTS } from "@/lib/pdf/template-registry";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { STYLE_FIELD_LABELS } from "@/lib/styles/resolved-fields";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { loadDocTypesWithUsage } from "@/lib/pdf/doc-types-db";
import { CustomOutputsGrid, type OutputPreview } from "./custom-outputs-grid";
import { DocTypesManager } from "./doc-types-manager";
import { requireAdminPage } from "@/lib/auth-server";

// Templates read DB-managed reference data (wash symbols, certificates,
// translations) at render time, so this can't be statically prerendered.
export const dynamic = "force-dynamic";

export default async function CustomOutputsPage() {
  await requireAdminPage();

  // Published Output Builder layouts appear in the catalogue alongside
  // code-registered variants.
  await ensureLayoutVariantsLoaded();

  // The doc-type catalogue (with usage counts for the management card);
  // labels feed the type badges on the preview cards.
  const docTypes = await loadDocTypesWithUsage(new Set(TEMPLATE_VARIANTS.map((v) => v.docType)));
  const labels = Object.fromEntries(docTypes.map((t) => [t.value, t.label]));

  const sample = buildSampleStyleData();

  // Render every catalogue variant with the shared sample data. Each
  // render is isolated so one failing template shows an error card instead
  // of blanking the whole page.
  const previews: OutputPreview[] = await Promise.all(
    allVariants().map(async (v): Promise<OutputPreview> => {
      const base = {
        key: v.key,
        name: v.name,
        description: v.description,
        docType: v.docType,
        docTypeLabel: docTypeLabel(v.docType, labels),
        widthMm: v.defaultWidthMm,
        heightMm: v.defaultHeightMm,
        requiredFields: v.requiredFields.map((f) => STYLE_FIELD_LABELS[f]),
      };
      try {
        const html = await v.render(sample, {
          widthMm: v.defaultWidthMm,
          heightMm: v.defaultHeightMm,
        });
        return { ...base, html, error: null };
      } catch (e) {
        return { ...base, html: null, error: e instanceof Error ? e.message : "Render failed" };
      }
    }),
  );

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Custom outputs</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Every output the system can produce, previewed with sample data in the dynamic fields —
          style name, sizes, EAN barcodes, composition, wash-care symbols and the rest. Use it to
          check a label&apos;s layout before wiring it onto a prod spec. <strong>Open PDF</strong> on
          any card renders the true print output.
        </p>
      </div>

      <DocTypesManager initialTypes={docTypes} />

      <CustomOutputsGrid previews={previews} />
    </div>
  );
}
