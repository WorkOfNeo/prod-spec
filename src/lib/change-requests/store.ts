// =====================================================
// Change requests — the shared store.
//
// The small set of writes and reads every part of the feature goes through:
// the agent job logs steps and posts messages, the review screen reads the
// whole request, approve/reject move an output's status. Keeping them in one
// place means the request-level status is always rolled up the same way, and
// every reader degrades the same way when the tables aren't deployed yet
// (P2021 → empty, see db-safe.ts).
// =====================================================

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { isMissingTable } from "./db-safe";
import type {
  AuthorKind,
  MessageKind,
  MemoryScope,
  MemorySourceKind,
  OutputStatus,
  RequestStatus,
} from "./types";

// ---------- status roll-up (pure) ----------

// A request's status is a summary of its outputs, ordered by who has to act:
// the agent first (WORKING), then the admin (IN_REVIEW — a FAILED run needs the
// admin too), then the requester (NEEDS_INFO), then the developer (NEEDS_CODE).
// Only when nothing is open does it settle on DONE or REJECTED.
export function rollUpStatus(statuses: readonly OutputStatus[]): RequestStatus {
  if (statuses.length === 0) return "NEW";
  const has = (s: OutputStatus) => statuses.includes(s);
  if (has("WORKING")) return "WORKING";
  if (has("IN_REVIEW") || has("FAILED")) return "IN_REVIEW";
  if (has("NEEDS_INFO")) return "NEEDS_INFO";
  if (has("NEEDS_CODE")) return "NEEDS_CODE";
  if (has("NEW")) return "NEW";
  if (has("APPROVED") || has("PUBLISHED")) return "DONE";
  return "REJECTED";
}

// Two outputs of one request settling at the same moment (two agent runs, an
// approval next to a run) would each read the other's OLD status and the
// slower write would win with a stale summary. So the roll-up locks the
// request row first: the second one waits, then reads what the first
// committed.
export async function rollUpRequestStatus(requestId: string): Promise<RequestStatus> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM change_requests WHERE id = ${requestId} FOR UPDATE`);
    const outputs = await tx.changeRequestOutput.findMany({ where: { requestId }, select: { status: true } });
    const status = rollUpStatus(outputs.map((o) => o.status as OutputStatus));
    await tx.changeRequest.update({ where: { id: requestId }, data: { status } });
    return status;
  });
}

// ---------- writes ----------

export async function appendMessage(input: {
  requestId: string;
  outputId?: string | null;
  authorKind: AuthorKind;
  authorUserId?: string | null;
  kind?: MessageKind;
  body: string;
  revisionId?: string | null;
  meta?: Prisma.InputJsonValue;
}) {
  return db.changeRequestMessage.create({
    data: {
      requestId: input.requestId,
      outputId: input.outputId ?? null,
      authorKind: input.authorKind,
      authorUserId: input.authorUserId ?? null,
      kind: input.kind ?? "message",
      body: input.body,
      revisionId: input.revisionId ?? null,
      meta: input.meta,
    },
  });
}

export async function logStep(input: {
  requestId: string;
  outputId?: string | null;
  kind: string;
  summary: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  detail?: Prisma.InputJsonValue;
}) {
  return db.changeRequestStep.create({
    data: {
      requestId: input.requestId,
      outputId: input.outputId ?? null,
      kind: input.kind,
      summary: input.summary.slice(0, 2000),
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      detail: input.detail,
    },
  });
}

// Move one output to a new status (plus any of its other fields), then roll the
// request up. Every status change goes through here.
export async function setOutputStatus(
  outputId: string,
  status: OutputStatus,
  patch: Omit<Prisma.ChangeRequestOutputUpdateInput, "status" | "request"> = {},
) {
  const out = await db.changeRequestOutput.update({
    where: { id: outputId },
    data: { ...patch, status },
    select: { id: true, requestId: true },
  });
  await rollUpRequestStatus(out.requestId);
  return out;
}

export async function createProposedMemory(input: {
  scope: MemoryScope;
  scopeRef?: string | null;
  text: string;
  sourceKind: MemorySourceKind;
  sourceRequestId?: string | null;
}) {
  return db.agentMemory.create({
    data: {
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      text: input.text.slice(0, 1000),
      state: "PROPOSED",
      sourceKind: input.sourceKind,
      sourceRequestId: input.sourceRequestId ?? null,
    },
  });
}

// ---------- reads ----------

const DETAIL_INCLUDE = {
  outputs: { orderBy: { position: "asc" } },
  attachments: {
    orderBy: { createdAt: "asc" },
    select: { id: true, outputId: true, mimeType: true, fileName: true, byteSize: true, createdAt: true },
  },
  messages: { orderBy: { createdAt: "asc" } },
  steps: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ChangeRequestInclude;

export type RequestDetail = Prisma.ChangeRequestGetPayload<{ include: typeof DETAIL_INCLUDE }>;

// The whole request for the review screen and the agent. Attachment bytes are
// never loaded here; they're served by the attachment route.
export async function getRequestDetail(id: string): Promise<RequestDetail | null> {
  try {
    return await db.changeRequest.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export async function getOutputWithRequest(outputId: string) {
  try {
    return await db.changeRequestOutput.findUnique({
      where: { id: outputId },
      include: { request: true },
    });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// Attachment bytes for the agent (vision) — only the images of one request.
export async function getAttachmentImages(requestId: string, outputId?: string | null) {
  try {
    return await db.changeRequestAttachment.findMany({
      where: { requestId, ...(outputId ? { OR: [{ outputId }, { outputId: null }] } : {}) },
      orderBy: { createdAt: "asc" },
      select: { id: true, outputId: true, data: true, mimeType: true, fileName: true },
    });
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}
