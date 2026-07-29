import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema, hasPerRowCartonEan, layoutSettings } from "@/lib/output-layouts/schema";
import { layoutReadinessColumns } from "@/lib/output-layouts/tokens";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import { parseProdSpecColumnMapping } from "@/lib/prod-spec/config";
import {
  effectiveStyleItem,
  resolveMappedField,
  STYLE_FIELD_LABELS,
} from "@/lib/styles/resolved-fields";
import type { MondayItem } from "@/lib/monday/client";

export const runtime = "nodejs";

// Test-style picker for the Output Builder: the styles of one
// (customer × business area), ranked by how many of THIS layout's
// required fields resolve on them — fullest first, so the builder
// auto-starts on a style where every variable has a value. Ranking
// reuses the exact resolution rules of output-readiness
// (effectiveStyleItem fallbacks + mapped-column reads), so "all fields
// filled" here means the Run button would be enabled there.
//
//   POST { customerId, businessAreaId, definition }
//     → { styles: [{ id, name, poNumber, filled, total, missing[] }] }

const BODY_SCHEMA = z.object({
  customerId: z.string().min(1),
  businessAreaId: z.string().min(1),
  definition: LayoutDefSchema,
  // Optional search across the pair's styles by name (IL-code) or PO
  // number. Without it, the most recent SCAN_LIMIT styles are ranked;
  // with it, the MATCHES are ranked — so a search can reach styles older
  // than the recency window.
  query: z.string().trim().max(80).optional(),
});

const SCAN_LIMIT = 80; // most recent styles considered
const RETURN_LIMIT = 25;

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { customerId, businessAreaId, definition, query } = parsed.data;

  const [styles, prodSpec] = await Promise.all([
    db.style.findMany({
      where: {
        customerId,
        businessAreaId,
        deletedAt: null,
        archivedAt: null,
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { poNumber: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
      select: {
        id: true,
        name: true,
        poNumber: true,
        completionPct: true,
        rawData: true,
        cartonEan: true,
        supplier: { select: { country: true } },
        // cartonEan is REQUIRED here, not incidental: without it the picker
        // can't see a style's per-size cartons and labels a per-carton-repeat
        // layout's perfectly renderable styles "missing Carton EAN".
        eans: {
          orderBy: { position: "asc" },
          select: { size: true, ean13: true, variantLabel: true, cartonEan: true },
        },
        customer: { select: { config: true } },
      },
    }),
    db.prodSpec.findUnique({
      where: { customerId_businessAreaId: { customerId, businessAreaId } },
      select: { columnMapping: true },
    }),
  ]);

  // Does this layout bind a carton per repetition row? Decides whether a
  // style's per-size cartons count toward the cartonEan requirement below.
  const perRowCarton = hasPerRowCartonEan(layoutSettings(definition));

  const ranked = styles
    .map((style) => {
      // Effective mapping mirrors output-readiness: the ProdSpec override
      // when it carries keys, the customer mapping otherwise.
      const customerMapping = parseCustomerConfig(style.customer.config).columnMapping;
      const psRaw = prodSpec?.columnMapping;
      const hasOverride =
        psRaw !== null && psRaw !== undefined && typeof psRaw === "object" && Object.keys(psRaw as object).length > 0;
      const mapping = hasOverride ? parseProdSpecColumnMapping(psRaw) : customerMapping;

      const item = effectiveStyleItem(style) as MondayItem | null;
      const resolve = (f: keyof ColumnMapping) => resolveMappedField(item, mapping, f);

      const required = layoutReadinessColumns(definition, resolve);
      // Mirrors output-readiness: on a layout that rebinds {{cartonEan}} per
      // repetition row, the style's per-size cartons satisfy the requirement
      // even when Style.cartonEan is NULL (normal for a style whose carton
      // column carries no "Assort - <EAN>" line). Without this the picker
      // disagreed with the Run gate — it ranked such styles last and labelled
      // them "missing Carton EAN" while the layout renders them fine.
      const hasPerSizeCarton =
        perRowCarton && style.eans.some((e) => (e.cartonEan ?? "").trim() !== "");
      const missing = required.filter(
        (f) => !resolve(f).trim() && !(f === "cartonEan" && hasPerSizeCarton),
      );
      return {
        id: style.id,
        name: style.name,
        poNumber: style.poNumber,
        completionPct: style.completionPct,
        filled: required.length - missing.length,
        total: required.length,
        missing: missing.map((f) => STYLE_FIELD_LABELS[f]),
      };
    })
    .sort(
      (a, b) =>
        a.missing.length - b.missing.length ||
        b.completionPct - a.completionPct ||
        a.name.localeCompare(b.name),
    )
    .slice(0, RETURN_LIMIT)
    .map((s) => ({
      id: s.id,
      name: s.name,
      poNumber: s.poNumber,
      filled: s.filled,
      total: s.total,
      missing: s.missing,
    }));

  return NextResponse.json({ styles: ranked });
}
