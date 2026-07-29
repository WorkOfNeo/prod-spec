import { db } from "@/lib/db";
import { setDynamicVariants, type TemplateVariant } from "@/lib/pdf/template-registry";
import type { StyleData } from "@/lib/pdf/types";
import { parseLayoutDef, type LayoutDef } from "./schema";
import {
  defNeedsDynamicReadiness,
  layoutReadinessColumns,
  resolveLayoutFileName,
  staticRequiredColumns,
} from "./tokens";
import { hasPerRowCartonEan, layoutSettings, type LayoutSettings } from "./schema";
import { renderLayoutHtml, repetitionStyles } from "./render";
import { pinnableFieldsInDef } from "./tokens";
import { applyFieldOverrides } from "@/lib/pdf/pins";

// =====================================================
// Layout → TemplateVariant bridge (SERVER-ONLY — imports db).
//
// Published OutputLayouts register as template variants under the key
// `layout:<id>`. From there the existing machinery is untouched: the
// ProdSpec output picker lists them, readiness gates them by the
// columns their tokens need, the runner renders them through
// renderLayoutHtml, review/approval sees a normal JobAsset.
//
// Loading model: the registry's dynamic-variant map is process-local
// and refreshed lazily with a short TTL. Every async entry point that
// can encounter a `layout:` key awaits ensureLayoutVariantsLoaded()
// first (runner, style pages, pickers, preview routes); the sync code
// below those entry points (getVariant, outputReadinessForStyle) then
// resolves from the already-loaded map. Mutating endpoints call
// refreshLayoutVariants() so a publish is visible immediately in-process.
// =====================================================

// The pure `layout:<id>` key helpers live in variant-keys.ts (no Prisma /
// render-pipeline imports). Imported for use below and re-exported so existing
// call sites keep importing them from this module unchanged.
import {
  LAYOUT_VARIANT_PREFIX,
  layoutVariantKey,
  isLayoutVariantKey,
  layoutIdFromVariantKey,
} from "./variant-keys";
export { LAYOUT_VARIANT_PREFIX, layoutVariantKey, isLayoutVariantKey, layoutIdFromVariantKey };

type LayoutRow = {
  id: string;
  name: string;
  docType: string;
  definition: unknown;
  version: number;
  isInfoArea: boolean;
  customLogo: string | null;
};

// The per-file plan when a repeat layout splits per EAN: one entry per
// repetition row — the JobAsset suffix plus the resolved custom file
// name (null → runner default + suffix). renderMany AND filesPreview
// both build on this, so the pre-run preview on the style page can
// never drift from the files a real run emits.
function splitFilePlan(
  settings: LayoutSettings,
  style: StyleData,
): Array<{ suffix: string; fileName: string | null; repStyle: StyleData }> {
  const reps = repetitionStyles(style, settings.repeatBy);
  const seen = new Map<string, number>();
  return reps.map((repStyle, i) => {
    const sizePart = (repStyle.sizes[0]?.label ?? "").replace(/[^\w.-]+/g, "");
    const colourPart =
      settings.repeatBy === "ean" || settings.repeatBy === "cartonEan"
        ? (repStyle.colour?.name ?? "").replace(/[^\w.-]+/g, "").slice(0, 16)
        : "";
    // The assortment row isn't a single size — name its file "assort" (deduped
    // below if a style ever resolves several assortment cartons). repeatBy
    // "cartonEan" appends such a row too, flagged isAssortment.
    let suffix =
      settings.repeatBy === "assort" || repStyle.isAssortment
        ? "assort"
        : [sizePart, colourPart].filter(Boolean).join("-").slice(0, 40) || String(i + 1);
    const n = (seen.get(suffix) ?? 0) + 1;
    seen.set(suffix, n);
    if (n > 1) suffix = `${suffix}-${n}`;
    return {
      suffix,
      fileName: settings.fileName ? resolveLayoutFileName(settings.fileName, repStyle) : null,
      repStyle,
    };
  });
}

export function layoutRowToVariant(row: LayoutRow): TemplateVariant | null {
  let def: LayoutDef;
  try {
    def = parseLayoutDef(row.definition);
  } catch (err) {
    console.warn(`[output-layouts] layout ${row.id} has an invalid definition, skipping: ${(err as Error).message}`);
    return null;
  }
  const first = def.pages[0];
  const requiredFields = staticRequiredColumns(def);
  const settings = layoutSettings(def);
  return {
    key: layoutVariantKey(row.id),
    docType: row.docType,
    name: row.name,
    // Bumped on every publish — feeds outputConfigKey so a re-published layout
    // edit registers as a "changed" output on the styles that use it.
    contentVersion: row.version,
    description: `Output Builder layout · v${row.version} · ${def.pages.length} page${def.pages.length === 1 ? "" : "s"} · ${def.pages
      .map((p) => `${p.widthMm}×${p.heightMm}`)
      .join(", ")} mm`,
    defaultWidthMm: first.widthMm,
    defaultHeightMm: first.heightMm,
    requiredFields,
    // The pinnable fields this layout prints — the review-time editor's
    // pre-filled inputs (structured/derived tokens drop out).
    editableFields: pinnableFieldsInDef(def),
    // Branch-dependent content ({{orderNo}}, {{if …}} conditionals) gates
    // readiness by the TAKEN branch only — evaluated per style.
    readiness: defNeedsDynamicReadiness(def) ? (resolve) => layoutReadinessColumns(def, resolve) : undefined,
    // Info-area layouts print at a per-style switchable size; the runner /
    // preview routes resolve it (admin InfoAreaSize or custom) and pass it
    // as `dims`, which we forward as a page-size override below.
    isInfoArea: row.isInfoArea,
    // Page dimensions live IN the layout (per page). For a normal layout the
    // ProdSpec-level dims are ignored (fixed page size); for an info area we
    // forward them as sizeOverrideMm so the layout prints at the chosen size.
    // Single-file path — also taken when a REPEATING layout has
    // splitBy "none": renderLayoutHtml expands every repetition into one
    // document, so the whole run still ships as exactly one PDF.
    render: (style, dims) =>
      renderLayoutHtml(def, style, {
        mode: "production",
        title: row.name,
        sizeOverrideMm: row.isInfoArea ? dims : undefined,
        customLogo: row.customLogo,
      }),
    fileNameFor: (style) => {
      const expr = settings.fileName;
      return expr ? resolveLayoutFileName(expr, style) : null;
    },
    // Manual carton-numbered prints are offered for layouts that opt in.
    cartonNumbering: settings.cartonNumbering,
    // Custom Carton Marking (multi-style box) — independent opt-in.
    multipleStyles: settings.multipleStyles,
    // Only the per-row repeats rebind {{cartonEan}} to the repetition row's
    // own carton, so only they let per-size cartons stand in for a missing
    // Style.cartonEan — see TemplateVariant.perRowCartonEan. The predicate is
    // shared with the test-style picker (hasPerRowCartonEan in ./schema).
    perRowCartonEan: hasPerRowCartonEan(settings),
    // Split per EAN: ONE FILE PER REPETITION ROW — repeat "size": per
    // size row; repeat "ean": per PO EAN row (size × colour,
    // {{colourName}} bound). Either way each file carries one EAN.
    renderMany:
      settings.repeatBy !== "none" && settings.splitBy === "ean"
        ? (style, dims, perDocOverrides) =>
            Promise.all(
              splitFilePlan(settings, style).map(async ({ suffix, fileName, repStyle }) => ({
                suffix,
                fileName,
                // Per-PDF override (reviewer edited THIS document's fields)
                // layers on top of the already whole-output-overridden row.
                html: await renderLayoutHtml(
                  def,
                  applyFieldOverrides(repStyle, perDocOverrides?.get(suffix)),
                  {
                    mode: "production",
                    sizeOverrideMm: row.isInfoArea ? dims : undefined,
                    customLogo: row.customLogo,
                  },
                ),
              })),
            )
        : undefined,
    // Per-document styles (one per PDF) for the review-time editor's per-PDF
    // pre-fill — same suffix + per-row narrowing as renderMany/filesPreview.
    docStyles:
      settings.repeatBy !== "none" && settings.splitBy === "ean"
        ? (style) => splitFilePlan(settings, style).map(({ suffix, repStyle }) => ({ suffix, style: repStyle }))
        : undefined,
    // Pre-run preview: the same plan WITHOUT rendering — what the style
    // page shows as "files the next run will generate".
    filesPreview: (style) =>
      settings.repeatBy !== "none" && settings.splitBy === "ean"
        ? splitFilePlan(settings, style).map(({ suffix, fileName }) => ({ suffix, fileName }))
        : [
            {
              suffix: null,
              fileName: settings.fileName ? resolveLayoutFileName(settings.fileName, style) : null,
            },
          ],
  };
}

let lastLoadedAt = 0;
let loadInFlight: Promise<void> | null = null;
let warnedUnavailable = false;
const TTL_MS = 10_000;

// Refresh the registry's dynamic variants from the DB. TTL-debounced so
// hot paths (style list readiness, runner batches) don't re-query per
// row; `force` busts the TTL (used right after a save/publish/delete).
//
// Resilient by design: this runs on pages that existed long before the
// Output Builder (styles list, prod-spec editor, custom outputs). If the
// output_layouts table isn't reachable yet — migration not applied, or a
// stale client — those pages must keep working with zero dynamic
// variants instead of crashing. We warn once and treat the load as done
// for one TTL window.
export async function ensureLayoutVariantsLoaded(force = false): Promise<void> {
  if (!force && Date.now() - lastLoadedAt < TTL_MS) return;
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    try {
      const rows = await db.outputLayout.findMany({
        where: { status: "PUBLISHED" },
        select: { id: true, name: true, docType: true, definition: true, version: true, isInfoArea: true, customLogo: true },
      });
      setDynamicVariants(
        rows
          .map((r) => layoutRowToVariant(r))
          .filter((v): v is TemplateVariant => v !== null),
      );
      warnedUnavailable = false;
      lastLoadedAt = Date.now();
    } catch (err) {
      // Table missing (P2021 — migration not applied yet) or transient DB
      // error: degrade to "no dynamic variants" rather than break callers.
      setDynamicVariants([]);
      lastLoadedAt = Date.now();
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.warn(
          `[output-layouts] could not load layouts (is the output_layouts migration applied? npm run db:deploy): ${(err as Error).message}`,
        );
      }
    } finally {
      loadInFlight = null;
    }
  })();
  return loadInFlight;
}

export async function refreshLayoutVariants(): Promise<void> {
  return ensureLayoutVariantsLoaded(true);
}
