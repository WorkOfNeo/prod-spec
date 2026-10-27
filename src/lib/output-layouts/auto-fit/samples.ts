// The styles an auto-fit is measured against. Read-only.
//
// Worst case over a handful of real styles is what makes a fit safe: white
// space on one style is the care text or a cert mark on another. The default
// set is the spec's newest live styles — a PO set, not archived or deleted,
// and not a placeholder named "…delete…".

import { db } from "@/lib/db";
import type { StyleData } from "@/lib/pdf/types";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import type { LayoutDef } from "../schema";
import {
  augmentCompositionTranslations,
  augmentTranslatedFields,
  compositionLangsInDef,
  langArgsInDef,
} from "../tokens";
import type { AutoFitSample } from "./fit-block";

export type SampleQuery = {
  prodSpecId?: string | null;
  // Always included, first (samples[0] is the one pictured).
  styleIds?: string[];
  // How many of the spec's newest live styles to add.
  take?: number;
  // Every definition the samples will render with (before and after an
  // edit): their language tokens are resolved once here, not on every render.
  defs: LayoutDef[];
};

export async function loadAutoFitSamples(q: SampleQuery): Promise<AutoFitSample[]> {
  const recent = q.prodSpecId
    ? await db.style.findMany({
        where: {
          prodSpecId: q.prodSpecId,
          archivedAt: null,
          deletedAt: null,
          poNumber: { not: null, notIn: [""] },
          NOT: { name: { contains: "delete", mode: "insensitive" } },
        },
        orderBy: { updatedAt: "desc" },
        take: q.take ?? 8,
        select: { id: true },
      })
    : [];
  const out: AutoFitSample[] = [];
  for (const id of [...new Set([...(q.styleIds ?? []), ...recent.map((s) => s.id)])]) {
    const ctx = await loadStyleRenderContext(id);
    if (!ctx) continue;
    out.push({ styleData: await augmentForDefs(ctx.styleData, q.defs), label: ctx.styleData.styleNumber ?? id });
  }
  return out;
}

// The augmentation prepareLayoutRender runs, over the union of languages, so
// each later render finds every value already present (it is idempotent).
async function augmentForDefs(style: StyleData, defs: LayoutDef[]): Promise<StyleData> {
  const langs = (key: string) => [...new Set(defs.flatMap((d) => langArgsInDef(d, key)))];
  const comp = [...new Set(defs.flatMap((d) => compositionLangsInDef(d)))];
  let out = style;
  if (comp.length > 0) out = await augmentCompositionTranslations(out, comp);
  return augmentTranslatedFields(out, {
    care: langs("careInstructions"),
    madeIn: langs("madeIn"),
    madeInLabel: langs("madeInLabel"),
    country: langs("country"),
    countryOfOriginLabel: langs("countryOfOriginLabel"),
    manufacturer: langs("manufacturer"),
  });
}
