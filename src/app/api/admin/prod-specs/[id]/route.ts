import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  BundlePageSettingsSchema,
  ProdSpecOutputsSchema,
  parseProdSpecLanguages,
  parseProdSpecOutputs,
} from "@/lib/prod-spec/config";
import { ColumnMappingSchema, RequiredFieldSchema } from "@/lib/customers/config";
import { resolveTicketsForRemovedOutputs } from "@/lib/tickets/rejection-tickets";
import { currentOutputBaseKeys } from "@/lib/tickets/orphan";
import { gainedOutputKeys } from "@/lib/prod-spec/outputs-version";
import { enqueueMissingOutputsForSpec } from "@/lib/outputs/prod-spec-rerun";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
// A save that ADDS an output also plans + enqueues the fan-out over the spec's
// styles (readiness walk + one createMany). Enqueue-only — the PDFs render in
// the background — but a spec with hundreds of styles needs more than the
// default to get through the plan.
export const maxDuration = 60;

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  // "Fully approved" admin toggle — its own explicit control, deliberately
  // excluded from `hasOtherChange` below so flipping it never auto-activates
  // the spec (approval readiness and active/enqueue-eligibility are separate).
  fullyApproved: z.boolean().optional(),
  autoGenerateThresholdPct: z.number().int().min(0).max(100).optional(),
  outputs: ProdSpecOutputsSchema.optional(),
  // Logo: either raw SVG markup (typically <10 KB) or a raster data URL
  // ("data:image/png;base64,…" / jpeg) when the operator uploads a
  // PNG/JPG. Cap accommodates a ~2 MB raster, which base64-encodes to
  // ~2.7 MB of string.
  logoSvg: z.string().max(4_000_000).nullable().optional(),
  // Markdown for the "General information" A4 page included in every
  // generated bundle. 100k chars is many pages — a generous ceiling that
  // still stops accidental paste bombs.
  generalInfoMd: z.string().max(100_000).nullable().optional(),
  // Print tuning for the two bundle framing pages — margins (mm), base
  // font (pt), line height, footer toggle; one block per page. Validated
  // against the canonical schema so out-of-range values 400 instead of
  // landing in the column.
  bundlePageSettings: BundlePageSettingsSchema.optional(),
  // Free-text per-language map. Lang keys are coerced to lowercase server-side.
  careInstructionsByLang: z.record(z.string().min(1), z.string().max(2000)).optional(),
  columnMapping: ColumnMappingSchema.optional(),
  requiredFields: z.array(RequiredFieldSchema).optional(),
  // Optional supplier set — if present, replaces the entire attached list.
  supplierIds: z.array(z.string().min(1)).optional(),
  // Output language codes (lowercase) this prod spec renders. Deliberately
  // excluded from `hasOtherChange` below: toggling languages (from the
  // editor or the /prod-specs/languages matrix) must not auto-activate a
  // draft prod spec.
  outputLanguages: z.array(z.string().min(1)).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const d = parsed.data;
  const existing = await db.prodSpec.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-activation: if the admin touched any non-active field, treat
  // the save as approval and flip `active = true`. Explicit `active`
  // wins (so the admin can deactivate something they're about to retire
  // even while editing it). Empty PATCH bodies leave `active` alone.
  const hasOtherChange =
    d.name !== undefined ||
    d.autoGenerateThresholdPct !== undefined ||
    d.outputs !== undefined ||
    d.logoSvg !== undefined ||
    d.generalInfoMd !== undefined ||
    d.bundlePageSettings !== undefined ||
    d.careInstructionsByLang !== undefined ||
    d.columnMapping !== undefined ||
    d.requiredFields !== undefined ||
    d.supplierIds !== undefined;
  const resolvedActive =
    d.active !== undefined ? d.active : hasOtherChange ? true : undefined;

  // Wrap the field update + supplier-set replacement in a transaction so a
  // partial save can't leave the join table inconsistent with the row.
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.prodSpec.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(resolvedActive !== undefined ? { active: resolvedActive } : {}),
        ...(d.fullyApproved !== undefined ? { fullyApproved: d.fullyApproved } : {}),
        ...(d.autoGenerateThresholdPct !== undefined ? { autoGenerateThresholdPct: d.autoGenerateThresholdPct } : {}),
        ...(d.outputs !== undefined ? { outputs: d.outputs as unknown as object } : {}),
        ...(d.logoSvg !== undefined ? { logoSvg: d.logoSvg } : {}),
        ...(d.generalInfoMd !== undefined
          ? { generalInfoMd: d.generalInfoMd?.trim() ? d.generalInfoMd : null }
          : {}),
        ...(d.bundlePageSettings !== undefined
          ? { bundlePageSettings: d.bundlePageSettings as unknown as object }
          : {}),
        ...(d.careInstructionsByLang !== undefined
          ? {
              careInstructionsByLang: Object.fromEntries(
                Object.entries(d.careInstructionsByLang)
                  .filter(([, v]) => v.trim().length > 0)
                  .map(([k, v]) => [k.toLowerCase(), v]),
              ) as unknown as object,
            }
          : {}),
        ...(d.columnMapping !== undefined ? { columnMapping: d.columnMapping as unknown as object } : {}),
        ...(d.requiredFields !== undefined ? { requiredFields: d.requiredFields as unknown as object } : {}),
        ...(d.outputLanguages !== undefined ? { outputLanguages: parseProdSpecLanguages(d.outputLanguages) } : {}),
      },
    });

    if (d.supplierIds !== undefined) {
      const wanted = new Set(d.supplierIds);
      const current = await tx.prodSpecSupplier.findMany({ where: { prodSpecId: id } });
      const currentIds = new Set(current.map((c) => c.supplierId));

      const toCreate = d.supplierIds.filter((sid) => !currentIds.has(sid));
      const toRemove = current.filter((c) => !wanted.has(c.supplierId));

      if (toRemove.length > 0) {
        await tx.prodSpecSupplier.deleteMany({
          where: { id: { in: toRemove.map((r) => r.id) } },
        });
      }
      if (toCreate.length > 0) {
        await tx.prodSpecSupplier.createMany({
          data: toCreate.map((supplierId) => ({ prodSpecId: id, supplierId })),
          skipDuplicates: true,
        });
      }
    }

    return updated;
  });

  // Output-set change → resolve tickets whose output was removed. Re-running
  // such an orphaned ticket could only NO_OUTPUTS-fail (it scopes a job to a
  // key no current output declares), so retire them here instead. Best-effort:
  // a cleanup miss must never fail the save the operator just made.
  let resolvedOrphanTickets = 0;
  if (d.outputs !== undefined) {
    try {
      resolvedOrphanTickets = await resolveTicketsForRemovedOutputs(
        id,
        currentOutputBaseKeys(d.outputs),
      );
    } catch (err) {
      console.warn(`[prod-specs] orphan-ticket cleanup skipped for ${id}: ${(err as Error).message}`);
    }
  }

  // Output ADDED → fan it out over the spec's existing styles, automatically.
  //
  // Without this an added output only ever reaches styles that have never
  // generated: the backlog sweep's status filter makes already-generated styles
  // invisible to it, so the rest sit with a declared-but-missing output until
  // somebody notices and clicks Run all. Bumping `outputsVersion` is what lets
  // the sweep find them; the immediate fan-out below is what makes it feel
  // instant instead of "some time in the next five minutes".
  //
  // Scope is MISSING-ONLY on purpose — approved, rejected and awaiting-review
  // documents are never touched, so this can't turn a spec edit into a re-review
  // of the whole book. Best-effort throughout: the operator's save has already
  // committed, and a fan-out failure must not surface as a failed save (the
  // sweep is the backstop either way).
  let outputsFanOut: FanOutSummary | null = null;
  if (d.outputs !== undefined) {
    try {
      outputsFanOut = await fanOutAddedOutputs({
        prodSpecId: id,
        specName: result.name,
        active: result.active,
        previousOutputs: existing.outputs,
        nextOutputs: d.outputs,
        user: { id: auth.userId, email: null },
      });
    } catch (err) {
      console.warn(`[prod-specs] new-output fan-out skipped for ${id}: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({ prodSpec: result, resolvedOrphanTickets, outputsFanOut });
}

type FanOutSummary = {
  // Base keys the save introduced — non-empty is what triggers everything below.
  addedKeys: string[];
  // Null when nothing was enqueued: spec inactive, auto-generate off, or every
  // style already covered. `reason` says which.
  batchId: string | null;
  enqueued: number;
  slots: number;
  skippedInFlight: number;
  reason: "enqueued" | "no_new_outputs" | "spec_inactive" | "auto_off" | "nothing_to_do";
};

async function fanOutAddedOutputs(input: {
  prodSpecId: string;
  specName: string;
  active: boolean;
  previousOutputs: unknown;
  nextOutputs: Array<{ variantKey: string; enabled?: boolean }>;
  user: { id: string | null; email: string | null };
}): Promise<FanOutSummary> {
  const nothing = (reason: FanOutSummary["reason"], addedKeys: string[] = []): FanOutSummary => ({
    addedKeys,
    batchId: null,
    enqueued: 0,
    slots: 0,
    skippedInFlight: 0,
    reason,
  });

  // A malformed stored blob parses to [] — every current key then reads as
  // "added", which would fan out the whole spec. Treat a parse failure as "no
  // reliable before-state" and skip rather than mass-enqueue.
  let previous: Array<{ variantKey: string; enabled?: boolean }>;
  try {
    previous = parseProdSpecOutputs(input.previousOutputs);
  } catch {
    return nothing("no_new_outputs");
  }

  const addedKeys = gainedOutputKeys(previous, input.nextOutputs);
  if (addedKeys.length === 0) return nothing("no_new_outputs");

  // Bump first, unconditionally: even when the fan-out below can't run right now
  // (inactive spec, auto-generate off), the version gap is what makes the sweep
  // pick these styles up once the blocker clears.
  await db.prodSpec.update({
    where: { id: input.prodSpecId },
    data: { outputsVersion: { increment: 1 } },
  });

  // The same two gates the auto-generate paths use. An inactive spec would
  // no-op every job in the runner; the master switch off means "sync, never
  // generate".
  if (!input.active) return nothing("spec_inactive", addedKeys);
  if (!(await getAutoGenerateEnabled())) return nothing("auto_off", addedKeys);

  const fan = await enqueueMissingOutputsForSpec({
    prodSpecId: input.prodSpecId,
    label: `New output${addedKeys.length === 1 ? "" : "s"}: ${input.specName}`,
    triggerSource: "SPEC_OUTPUT_ADDED",
    user: input.user,
  });

  return {
    addedKeys,
    batchId: fan.batchId,
    enqueued: fan.enqueued,
    slots: fan.slots,
    skippedInFlight: fan.skippedInFlight,
    reason: fan.enqueued > 0 ? "enqueued" : "nothing_to_do",
  };
}
