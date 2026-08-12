import { db as dbClient, type DbClient } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { hasPoNumber } from "@/lib/styles/active-filter";

// Thrown when a caller tries to generate for a style with no PO number
// ("Navision Task"). Named so routes can answer 422 with the operator's own
// vocabulary instead of leaking a 500 — see isMissingPoNumber below.
export class MissingPoNumberError extends Error {
  readonly styleId: string;
  constructor(styleId: string) {
    super(
      "This style has no PO number yet (Monday's \"Navision Task\" cell is empty), " +
        "so nothing can be generated for it.",
    );
    this.name = "MissingPoNumberError";
    this.styleId = styleId;
  }
}

export function isMissingPoNumber(err: unknown): err is MissingPoNumberError {
  return err instanceof MissingPoNumberError;
}

export async function enqueueGenerationJob(input: {
  styleId: string;
  triggerSource: TriggerSource;
  // Output variant keys this job should render. Per-output generation: the
  // auto-enqueue paths pass the outputs whose own required fields just
  // landed. Omitted / empty ⇒ the runner renders all enabled outputs
  // (manual full-regen / legacy behaviour).
  variantKeys?: string[];
  // Transaction client for atomic / rollback-test callers (see DbClient).
  // Defaults to the global `db`.
  client?: DbClient;
}): Promise<{ jobId: string }> {
  const db = input.client ?? dbClient;
  // Snapshot the Style's resolved ProdSpec so analytics queries can group
  // jobs by ProdSpec without joining through Style (and so the link
  // survives even if the Style later changes its ProdSpec, e.g. after a
  // BA reassignment). Reads only the columns we need to keep this cheap.
  const style = await db.style.findUnique({
    where: { id: input.styleId },
    select: { prodSpecId: true, poNumber: true },
  });

  // THE PO GATE, at the one helper every non-bulk path funnels through.
  //
  // Nothing can be generated without a PO number: until the buyer fills the
  // Monday Pre-Order board's "Navision Task" cell the row is a placeholder,
  // not work. #290 gated the LIST on this; a listed-but-ungenerated style was
  // the visible half of the rule, and this is the other half — otherwise a
  // style hidden from /styles could still be rendered and pushed to a supplier
  // by the sweep, a webhook handoff or a rejection re-run.
  //
  // A throw, not a silent skip: the auto paths check hasPoNumber themselves and
  // report a `no_po` skip before reaching here, so anything that gets this far
  // is a caller that forgot — which is a bug, not a routine outcome. Reuses the
  // list's own predicate so the two can't drift.
  if (!hasPoNumber(style?.poNumber)) throw new MissingPoNumberError(input.styleId);

  const job = await db.job.create({
    data: {
      styleId: input.styleId,
      prodSpecId: style?.prodSpecId ?? null,
      triggerSource: input.triggerSource,
      status: "QUEUED",
      // documentTypes is left empty — the runner picks variants from the
      // resolved ProdSpec at processing time, not from a snapshot here.
      // Kept on the model for backward compat with old rows.
      documentTypes: [],
      variantKeys: input.variantKeys ?? [],
    },
  });
  const scope =
    input.variantKeys && input.variantKeys.length > 0
      ? ` · outputs: ${input.variantKeys.join(", ")}`
      : "";
  await db.log.create({
    data: {
      jobId: job.id,
      level: "INFO",
      message: `job enqueued (${input.triggerSource.toLowerCase()})${scope}`,
    },
  });
  return { jobId: job.id };
}
