import { allVariants } from "@/lib/pdf/template-registry";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { STYLE_FIELD_LABELS } from "@/lib/styles/resolved-fields";
import { CustomOutputsGrid, type OutputPreview } from "./custom-outputs-grid";
import { requireAdminPage } from "@/lib/auth-server";

// Templates read DB-managed reference data (wash symbols, certificates,
// translations) at render time, so this can't be statically prerendered.
export const dynamic = "force-dynamic";

export default async function CustomOutputsPage() {
  await requireAdminPage();

  // Published Output Builder layouts appear in the catalogue alongside
  // code-registered variants.
  await ensureLayoutVariantsLoaded();

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

      <CustomOutputsGrid previews={previews} />
    </div>
  );
}
