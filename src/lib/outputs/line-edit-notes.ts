import { db } from "@/lib/db";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import type { StyleData } from "@/lib/pdf/types";
import { authoredLineAt, emptyTokensAddedByEdit, resolveLinePlain } from "@/lib/output-layouts/lines";
import {
  augmentForDef,
  publishedDef,
  resolveOutputTarget,
  splitVariantKey,
  type OutputTarget,
} from "@/lib/output-layouts/render-output";
import { isLayoutVariantKey, layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { loadStyleLineValueRows } from "./output-line-values";

// =====================================================
// Hand-edited lines, made VISIBLE (SERVER-ONLY — imports db).
//
// "Edit any line" lets a reviewer rewrite one line of one style's document,
// and the rewrite is stored per style — not in Monday, not in the layout. So a
// label that prints differently from its sibling (same PO, same layout, same
// data) gives no clue why: the only trace was inside the review dialog's line
// list. This builds what the style page's Review tab shows on each card: who
// rewrote which line, what the layout says there, what the edit says, what it
// actually prints, and which of the edit's own tokens print NOTHING here.
//
// The last one is the failure that started this: an edit reading
// "{{composition:da}} /    {{composition:de}}" on a German-only layout. The
// layout never asks for Danish, so the Danish composition is never translated,
// the token resolves to "", and the label prints a stray "/" plus the padding.
//
// Faithful to the print: each output resolves through the same target the
// runner renders (admin pins + the style's field values), with the same
// translation augmentation (augmentForDef) and the same per-PDF split
// (docStyles) — so "Prints" is what the PDF says, not a guess.
//
// Cheap on the common path: one indexed query, and nothing else when the style
// has no line edits (almost all of them). Fails soft to [] — a display aid
// must never break the page.
// =====================================================

export type LineEditNote = {
  id: string;
  // As stored: the base key ("layout:<id>") = every PDF of the output;
  // "<base>#<suffix>" = one document of a split output.
  variantKey: string;
  baseKey: string;
  // The one document the edit applies to, or null for every PDF.
  documentSuffix: string | null;
  lineKey: string;
  // The reviewer's source line, exactly as saved (whitespace included).
  value: string;
  // The layout's own line at that address; null when the layout no longer has
  // it (or the layout couldn't be loaded).
  authored: string | null;
  // Plain-text resolution of the edit for this style — what the PDF prints on
  // that line. Null when the style couldn't be resolved.
  printed: string | null;
  // Tokens the edit added that print nothing for this style (on any of its
  // PDFs) — the stray-separator case.
  emptyTokens: string[];
  editedByName: string | null;
  editedAt: string; // ISO
};

type OutputContext = { def: LayoutDef | null; docs: Array<{ suffix: string | null; style: StyleData }> };

// The rendered style(s) of one output: the whole-output style, augmented the
// way its layout renders it, then split into the PDFs the run emits (each with
// its own per-PDF field values). A non-splitting output is one document.
async function outputContext(
  baseKey: string,
  ctx: Awaited<ReturnType<typeof loadStyleRenderContext>>,
): Promise<OutputContext> {
  const layoutId = isLayoutVariantKey(baseKey) ? layoutIdFromVariantKey(baseKey) : null;
  let target: OutputTarget | null = null;
  if (ctx) {
    try {
      target = await resolveOutputTarget({ ctx, variantKey: baseKey });
    } catch {
      // Output no longer configured / layout unpublished — fall back below.
    }
  }
  const def = target?.def ?? (layoutId ? await publishedDef(layoutId) : null);
  if (!ctx || !def) return { def, docs: [] };

  const whole = await augmentForDef(target?.styleData ?? ctx.styleData, def);
  const split = target?.variant.docStyles?.(whole);
  const docs =
    split && split.length > 0
      ? split.map((d) => ({
          suffix: d.suffix,
          style: applyFieldOverrides(d.style, target?.fieldValues.get(`${baseKey}#${d.suffix}`)),
        }))
      : [{ suffix: null, style: whole }];
  return { def, docs };
}

export async function loadLineEditNotes(styleId: string): Promise<LineEditNote[]> {
  try {
    const rows = await loadStyleLineValueRows(styleId);
    if (rows.length === 0) return [];

    const userIds = [...new Set(rows.map((r) => r.updatedById).filter((v): v is string => !!v))];
    const [users, ctx] = await Promise.all([
      userIds.length > 0
        ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
        : Promise.resolve([]),
      loadStyleRenderContext(styleId).catch(() => null),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));

    const byBase = new Map<string, OutputContext>();
    for (const baseKey of new Set(rows.map((r) => splitVariantKey(r.variantKey).baseKey))) {
      byBase.set(baseKey, await outputContext(baseKey, ctx).catch(() => ({ def: null, docs: [] })));
    }

    return rows.map((r) => {
      const { baseKey, suffix } = splitVariantKey(r.variantKey);
      const out = byBase.get(baseKey) ?? { def: null, docs: [] };
      const authored = out.def ? authoredLineAt(out.def, r.lineKey) : null;
      // A per-PDF edit prints on that PDF only; a whole-output edit on all of
      // them — a token is flagged if it prints nothing on ANY of them.
      const docs = suffix != null ? out.docs.filter((d) => d.suffix === suffix) : out.docs;
      const empty = new Set<string>();
      for (const d of docs) for (const t of emptyTokensAddedByEdit(r.value, authored, d.style)) empty.add(t);
      return {
        id: r.id,
        variantKey: r.variantKey,
        baseKey,
        documentSuffix: suffix,
        lineKey: r.lineKey,
        value: r.value,
        authored,
        printed: docs[0] ? resolveLinePlain(r.value, docs[0].style) : null,
        emptyTokens: [...empty],
        editedByName: r.updatedById ? (nameById.get(r.updatedById) ?? null) : null,
        editedAt: r.updatedAt.toISOString(),
      };
    });
  } catch {
    return [];
  }
}
