import { db } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { PHASE_1_DOC_TYPES } from "@/lib/pdf/generate";

export async function enqueueGenerationJob(input: {
  styleId: string;
  triggerSource: TriggerSource;
}): Promise<{ jobId: string }> {
  const job = await db.job.create({
    data: {
      styleId: input.styleId,
      triggerSource: input.triggerSource,
      status: "QUEUED",
      documentTypes: PHASE_1_DOC_TYPES,
    },
  });
  await db.log.create({
    data: {
      jobId: job.id,
      level: "INFO",
      message: `job enqueued (${input.triggerSource.toLowerCase()})`,
    },
  });
  return { jobId: job.id };
}
