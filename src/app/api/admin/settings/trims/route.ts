import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import {
  getTrimLabelOverrides,
  getTrimLayoutConcepts,
  getTrimRules,
  setTrimLabelOverrides,
  setTrimLayoutConcepts,
  setTrimRules,
} from "@/lib/settings/app-settings";
import { buildTrimCensus } from "@/lib/trims/census";
import { loadTrimConceptRows } from "@/lib/trims/catalogue";

export const runtime = "nodejs";
// The census plucks the Trims cell out of ~6,000 Monday blobs in Postgres —
// seconds, not the ninety a Node-side scan takes, but well past the default.
export const maxDuration = 120;

// Trims -> concept configuration, and the fleet-wide picture behind it.
//
// ADMIN + REVIEWER, matching the cover-page block next door: what a trim MEANS
// is reviewer knowledge (they are the ones reading Monday against the artwork),
// and the only thing it can change is which rows print on a cover. It arms
// nothing and sends nothing.
//
//   GET /api/admin/settings/trims          -> { concepts, rules, overrides, layoutConcepts, census }
//   PUT /api/admin/settings/trims { ... }  -> saves whichever parts are present
//
// `concepts` is the cover page's packaging ROWS, loaded from the table rather
// than from a code constant — the list a person adds to at
// /settings/cover-page?tab=packaging, and the list a trim value is matched onto
// here. One catalogue, two screens.

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [rules, overrides, layoutConcepts, concepts] = await Promise.all([
    getTrimRules(),
    getTrimLabelOverrides(),
    getTrimLayoutConcepts(),
    // The cover page's packaging rows — the list a trim can be mapped ONTO.
    // Read before the census, which classifies against the same catalogue.
    loadTrimConceptRows(),
  ]);

  // Fail-soft: a census that throws (a Monday blob shaped unexpectedly, a slow
  // query) must still leave the rule editor usable — that is the screen a
  // person came to fix things on.
  const census = await buildTrimCensus().catch((err) => {
    console.warn("[trims] census failed:", err);
    return null;
  });

  return NextResponse.json({
    concepts,
    rules,
    overrides,
    layoutConcepts,
    census,
    censusError: census === null,
  });
}

const RULE = z.object({
  concept: z.string().min(1).max(64),
  keywords: z.array(z.string().max(120)).max(50),
});

const BODY = z.object({
  // Order is semantic (first match wins), so the array is stored exactly as
  // sent — the editor owns the ordering.
  rules: z.array(RULE).max(200).optional(),
  // Normalised label -> concepts. An empty array is a real, storable decision
  // ("not packaging"), which is why the value is not `.min(1)`.
  overrides: z.record(z.string(), z.array(z.string().max(64)).max(10)).optional(),
  // Base variantKey -> concept. "" means "answers no trim".
  layoutConcepts: z.record(z.string(), z.string().max(64)).optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { rules, overrides, layoutConcepts } = parsed.data;
  if (rules) await setTrimRules(rules);
  if (overrides) await setTrimLabelOverrides(overrides);
  if (layoutConcepts) await setTrimLayoutConcepts(layoutConcepts);

  return NextResponse.json({ ok: true });
}
