// The styles an auto-fit is measured against. Read-only.
//
// Worst case over a handful of real styles is what makes a fit safe: white
// space on one style is the care text or a cert mark on another. So samples
// must be COMPLETE: every token the face prints resolves on them (the same
// check as the builder's "missing on this style" chips). A style with no
// care instructions would otherwise be measured — and pictured — with a hole
// where the care text goes. Candidates are the spec's newest live styles (a
// PO set, not archived or deleted, not a placeholder named "…delete…").
//
// "Every token" means every token SOME candidate fills: a field nobody on the
// spec fills (a price column left empty, say) can't be sampled anyway, so it
// doesn't disqualify a style; it's reported as never filled instead.

import { db } from "@/lib/db";
import type { StyleData } from "@/lib/pdf/types";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import type { LayoutDef } from "../schema";
import {
  augmentCompositionTranslations,
  augmentTranslatedFields,
  compositionLangsInDef,
  langArgsInDef,
  unresolvedTokens,
} from "../tokens";
import { pickCompleteSamples, type ScannedStyle } from "./completeness";
import type { AutoFitSample } from "./fit-block";

export type SampleQuery = {
  prodSpecId?: string | null;
  // Measured if complete, and pictured first.
  styleIds?: string[];
  // Complete samples wanted.
  take?: number;
  // Newest live styles examined for completeness.
  scan?: number;
  // Every definition the samples will render with (before and after an
  // edit): their language tokens are resolved once here, not on every render.
  defs: LayoutDef[];
  // Completeness is judged on these pages of this definition — the face
  // being fitted, with its new text.
  completeOn: { def: LayoutDef; pages: number[] };
};

export type SampleSet = {
  samples: AutoFitSample[];
  scanned: number;
  // Tokens no scanned style fills.
  neverFilled: string[];
  // Scanned styles left out, with what they're missing (newest first).
  incomplete: Array<{ label: string; missing: string[] }>;
};

export async function loadAutoFitSamples(q: SampleQuery): Promise<SampleSet> {
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
        take: q.scan ?? 40,
        select: { id: true },
      })
    : [];
  const face: LayoutDef = { ...q.completeOn.def, pages: q.completeOn.pages.map((i) => q.completeOn.def.pages[i]) };
  const scanned: Array<ScannedStyle<AutoFitSample>> = [];
  for (const id of [...new Set([...(q.styleIds ?? []), ...recent.map((s) => s.id)])]) {
    const ctx = await loadStyleRenderContext(id);
    if (!ctx) continue;
    const styleData = await augmentForDefs(ctx.styleData, q.defs);
    const label = ctx.styleData.styleNumber ?? id;
    scanned.push({ sample: { styleData, label }, label, missing: unresolvedTokens(face, styleData) });
  }
  return { ...pickCompleteSamples(scanned, q.take ?? 8), scanned: scanned.length };
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
