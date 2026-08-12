import { db, type DbClient } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { enqueueGenerationJob } from "./enqueue";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { pendingOutputKeysForStyle } from "@/lib/styles/output-readiness";
import { hasPoNumber } from "@/lib/styles/active-filter";

// Why the style was NOT auto-enqueued. Surfaced for logging/tests so a
// caller can tell "switched off" apart from "already covered".
export type AutoEnqueueSkip =
  | "auto_off"
  | "no_po"
  | "prod_spec_inactive"
  | "in_flight"
  | "nothing_pending";

export type AutoEnqueueResult =
  | { enqueued: true; jobId: string; variantKeys: string[] }
  | { enqueued: false; skipped: AutoEnqueueSkip; variantKeys: string[] };

// =====================================================
// Single source of truth for "a sync/ingest just landed fields on a style —
// should we generate the now-ready outputs, with no manual click?".
//
// Backlog T6 ("auto-run when ready"): the three ingest/sync paths that flip
// readiness — the Monday item webhook, the bulk Pre-Order sync, and the
// /import promotion — all share this exact gate, so they can never drift.
// Per-output: it enqueues precisely the outputs whose OWN required fields
// are now filled and that don't already have an up-to-date asset, never the
// whole prod spec.
//
// Gates, evaluated cheapest-first; the FIRST one that fails wins:
//   1. autoGenerateEnabled — the global master switch (Settings). OFF ⇒
//      sync the style but never generate. Pass a pre-read value in bulk
//      loops so a 4k-item sync doesn't read AppSetting per row.
//   1b. PO number — the Monday "Navision Task" cell. Empty ⇒ the row is a
//      placeholder, not work: it syncs, it doesn't list (#290) and it does
//      not generate. Same hasPoNumber predicate as the /styles gate.
//   2. prodSpecActive — an inactive (auto-scaffolded, unreviewed) ProdSpec
//      never auto-generates; an operator activates it first.
//   3. in-flight — a QUEUED/RUNNING job already covers this style, so we
//      never stack a duplicate. Any output that becomes ready while that
//      job runs is picked up on the next sync.
//   4. pendingOutputKeysForStyle — ready outputs MINUS the ones already
//      generated (a non-FAILED JobAsset). Empty ⇒ nothing to do. This is
//      where idempotency lives: repeat syncs re-compute the same set and
//      find it empty, so they never re-enqueue an up-to-date output.
//      ProdSpec.autoGenerateThresholdPct is honoured implicitly here — in
//      the per-output model each output gates on its own required fields,
//      the granular successor to the union completion threshold (see
//      computeReadiness in src/lib/styles/readiness.ts).
//
// Deliberately does NOT call triggerRunner(): the caller fires it once (a
// single inline kick for a webhook event; one kick at the end of a bulk
// run). The runner is idempotent, so the exact timing is not load-bearing.
// =====================================================
export async function autoEnqueueReadyOutputs(input: {
  styleId: string;
  prodSpecActive: boolean;
  triggerSource: TriggerSource;
  // Pre-read master switch. Omit to have the helper read it (single-item
  // callers); pass it in bulk loops to avoid a per-row AppSetting query.
  autoGenerateEnabled?: boolean;
  // Transaction client for atomic / rollback-test callers. Defaults to the
  // global `db`.
  client?: DbClient;
}): Promise<AutoEnqueueResult> {
  const client = input.client ?? db;

  const autoOn = input.autoGenerateEnabled ?? (await getAutoGenerateEnabled());
  if (!autoOn) return { enqueued: false, skipped: "auto_off", variantKeys: [] };

  // The PO gate. A sync that lands fields on a style whose "Navision Task" cell
  // is still empty must not start generating for it — the row is a placeholder
  // until the buyer fills that cell, which is exactly why #290 keeps it off the
  // list. Reported as a skip (not thrown) so a 4k-item Pre-Order sync walks past
  // its placeholders quietly; enqueueGenerationJob is the hard backstop below.
  const gateRow = await client.style.findUnique({
    where: { id: input.styleId },
    select: { poNumber: true },
  });
  if (!hasPoNumber(gateRow?.poNumber)) {
    return { enqueued: false, skipped: "no_po", variantKeys: [] };
  }

  if (!input.prodSpecActive) {
    return { enqueued: false, skipped: "prod_spec_inactive", variantKeys: [] };
  }

  const inflight = await client.job.count({
    where: { styleId: input.styleId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) return { enqueued: false, skipped: "in_flight", variantKeys: [] };

  const variantKeys = await pendingOutputKeysForStyle(input.styleId, client);
  if (variantKeys.length === 0) {
    return { enqueued: false, skipped: "nothing_pending", variantKeys: [] };
  }

  const { jobId } = await enqueueGenerationJob({
    styleId: input.styleId,
    triggerSource: input.triggerSource,
    variantKeys,
    client,
  });
  return { enqueued: true, jobId, variantKeys };
}
