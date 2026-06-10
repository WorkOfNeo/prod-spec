import { db } from "@/lib/db";
import type { DocType } from "@/generated/prisma/enums";
import { setDynamicVariants, type TemplateVariant } from "@/lib/pdf/template-registry";
import { parseLayoutDef, type LayoutDef } from "./schema";
import { layoutReadinessColumns, staticRequiredColumns, defNeedsDynamicReadiness } from "./tokens";
import { renderLayoutHtml } from "./render";

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

export const LAYOUT_VARIANT_PREFIX = "layout:";

export function layoutVariantKey(layoutId: string): string {
  return `${LAYOUT_VARIANT_PREFIX}${layoutId}`;
}

export function isLayoutVariantKey(key: string): boolean {
  return key.startsWith(LAYOUT_VARIANT_PREFIX);
}

type LayoutRow = {
  id: string;
  name: string;
  docType: DocType;
  definition: unknown;
  version: number;
};

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
  return {
    key: layoutVariantKey(row.id),
    docType: row.docType,
    name: row.name,
    description: `Output Builder layout · v${row.version} · ${def.pages.length} page${def.pages.length === 1 ? "" : "s"} · ${def.pages
      .map((p) => `${p.widthMm}×${p.heightMm}`)
      .join(", ")} mm`,
    defaultWidthMm: first.widthMm,
    defaultHeightMm: first.heightMm,
    requiredFields,
    // Branch-dependent content ({{orderNo}}, {{if …}} conditionals) gates
    // readiness by the TAKEN branch only — evaluated per style.
    readiness: defNeedsDynamicReadiness(def) ? (resolve) => layoutReadinessColumns(def, resolve) : undefined,
    // Page dimensions live IN the layout (per page) — the ProdSpec-level
    // dims override that applies to coded variants is ignored here (the
    // dims param is dropped from the signature deliberately).
    render: (style) => renderLayoutHtml(def, style, { mode: "production", title: row.name }),
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
        select: { id: true, name: true, docType: true, definition: true, version: true },
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
