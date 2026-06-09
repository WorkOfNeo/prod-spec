import { db } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";

export async function enqueueGenerationJob(input: {
  styleId: string;
  triggerSource: TriggerSource;
  // Output variant keys this job should render. Per-output generation: the
  // auto-enqueue paths pass the outputs whose own required fields just
  // landed. Omitted / empty ⇒ the runner renders all enabled outputs
  // (manual full-regen / legacy behaviour).
  variantKeys?: string[];
}): Promise<{ jobId: string }> {
  // Snapshot the Style's resolved ProdSpec so analytics queries can group
  // jobs by ProdSpec without joining through Style (and so the link
  // survives even if the Style later changes its ProdSpec, e.g. after a
  // BA reassignment). Reads only the column we need to keep this cheap.
  const style = await db.style.findUnique({
    where: { id: input.styleId },
    select: { prodSpecId: true },
  });

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
