import { db } from "@/lib/db";
import { parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { layoutVariantKey } from "./variant-keys";

// =====================================================
// Who prints a layout (SERVER-ONLY — imports db; the matching itself is the
// pure layoutOutputsInSpecs below).
//
// "Uses the layout" here means: an ENABLED output on the ProdSpec whose base
// variantKey is layout:<id>, and — for styles — a style on such a ProdSpec
// that is neither archived nor deleted. That is the set a publish would
// actually change on the next run, which is what change-request impact and
// proofs need.
//
// Two older "used by" readings exist and are deliberately left alone:
//   • rejection-ai/ai-fix.ts counts ProdSpecs that DECLARE the layout, enabled
//     or not (its blast-radius number).
//   • the Output Builder list page (output-builder/page.tsx) matches enabled
//     outputs by raw key prefix and lists every style on those specs, archived
//     and deleted included.
// =====================================================

export type LayoutSpecUsage<S> = { spec: S; output: ProdSpecOutput };

// Pure: the specs among `specs` that print this layout, each with the output
// that does it (the first enabled one — the same output the render context
// resolves, by base key). A spec whose outputs JSON doesn't parse is skipped
// rather than failing the whole scan.
export function layoutOutputsInSpecs<S extends { outputs: unknown }>(
  specs: readonly S[],
  layoutId: string,
): LayoutSpecUsage<S>[] {
  const key = layoutVariantKey(layoutId);
  const out: LayoutSpecUsage<S>[] = [];
  for (const spec of specs) {
    let outputs: ProdSpecOutput[];
    try {
      outputs = parseProdSpecOutputs(spec.outputs);
    } catch {
      continue;
    }
    const output = outputs.find((o) => o.enabled !== false && baseVariantKey(o.variantKey) === key);
    if (output) out.push({ spec, output });
  }
  return out;
}

export type LayoutProdSpecUsage = {
  prodSpecId: string;
  prodSpecName: string;
  output: ProdSpecOutput;
};

export async function prodSpecsUsingLayout(layoutId: string): Promise<LayoutProdSpecUsage[]> {
  const specs = await db.prodSpec.findMany({
    select: { id: true, name: true, outputs: true },
    orderBy: { name: "asc" },
  });
  return layoutOutputsInSpecs(specs, layoutId).map(({ spec, output }) => ({
    prodSpecId: spec.id,
    prodSpecName: spec.name,
    output,
  }));
}

export type LayoutStyleUsage = {
  styleId: string;
  prodSpecId: string;
  label: string;
  poNumber: string | null;
  output: ProdSpecOutput;
};

// Styles that print the layout, most recently updated first. `limit` caps the
// rows read; a caller that refuses above N styles asks for N + 1 and checks.
export async function stylesUsingLayout(
  layoutId: string,
  opts: { limit?: number } = {},
): Promise<LayoutStyleUsage[]> {
  const specs = await prodSpecsUsingLayout(layoutId);
  if (specs.length === 0) return [];
  const outputBySpec = new Map(specs.map((s) => [s.prodSpecId, s.output]));
  const styles = await db.style.findMany({
    where: { prodSpecId: { in: [...outputBySpec.keys()] }, archivedAt: null, deletedAt: null },
    select: { id: true, name: true, poNumber: true, prodSpecId: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    ...(opts.limit !== undefined ? { take: opts.limit } : {}),
  });
  const rows: LayoutStyleUsage[] = [];
  for (const s of styles) {
    const output = s.prodSpecId ? outputBySpec.get(s.prodSpecId) : undefined;
    if (!s.prodSpecId || !output) continue;
    rows.push({ styleId: s.id, prodSpecId: s.prodSpecId, label: s.name, poNumber: s.poNumber, output });
  }
  return rows;
}
