// =====================================================
// Change requests — the review screen's view of one request
// (/requests/[id] and its polling twin GET /api/admin/change-requests/[id]).
//
// One loader for both so the page's first render and every 3-second poll show
// exactly the same thing: the request, each output with its draft history
// (revision summaries, never the definitions), the thread with memory cards
// resolved to their current state, the agent's run log, and — once live —
// what the approval did (read back from its thread note).
//
// Who sees what is decided here too:
//   • an ADMIN sees everything;
//   • the REVIEWER who filed the request sees a requester's view: status,
//     their issues and screenshots, the thread — no run log or cost, no
//     drafts, impact or code spec, no memory suggestions (those are the
//     admin's to keep or dismiss);
//   • anyone else sees nothing (the caller answers 403 / redirects).
//
// Everything in a view is plain JSON (dates as ISO strings plus labels
// formatted here, on the server, so the client never re-formats them in
// another time zone). buildRequestView / redactForRequester are pure.
// =====================================================

import { db } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { formatDate } from "@/lib/utils";
import type { UserRole } from "@/generated/prisma/enums";
import { orEmpty } from "@/lib/change-requests/db-safe";
import { getRequestDetail, type RequestDetail } from "@/lib/change-requests/store";
import {
  CodeSpecSchema,
  ImpactSummarySchema,
  requestRef,
  type AuthorKind,
  type ImpactSummary,
  type MessageKind,
  type OutputStatus,
  type RequestSource,
  type RequestStatus,
} from "@/lib/change-requests/types";

export type ReviewViewer = { userId: string; role: UserRole | null };

export type AttachmentView = { id: string; fileName: string; mimeType: string; byteSize: number };

export type RevisionView = {
  id: string;
  number: number;
  status: string;
  authorKind: string;
  note: string | null;
  parentRevisionId: string | null;
  publishedVersion: number | null;
  createdAt: string;
  createdLabel: string;
};

// What the approval did, from its "published" thread note.
export type PublishedInfo = {
  publishedVersion: number | null;
  forced: boolean;
  rerun: {
    enqueued: number;
    documents: number;
    skippedNoPo: number;
    skippedBelowCutoff: number;
    skippedInFlight: number;
    error: string | null;
  } | null;
  approvedChanged: number;
  deliveredChanged: number;
  impactError: string | null;
  summary: string;
  // Styles whose approved documents were sent back to review since.
  sentBackStyleIds: string[];
};

export type CodeSpecView = {
  tokenKey: string;
  label: string;
  rule: string;
  board: string;
  column: string;
  cases: number;
};

export type OutputView = {
  id: string;
  position: number;
  label: string;
  variantKey: string | null;
  layoutId: string | null;
  styleId: string | null;
  text: string;
  status: OutputStatus;
  attachments: AttachmentView[];
  rejectReason: string | null;
  publishedLabel: string | null;
  // Admin-only below (empty / null in a requester's view).
  // The layout a draft of this output changes — what approving publishes.
  layoutName: string | null;
  // The layout was pinned by an agent run (find_layouts), not at filing: the
  // output names no configured output (no variantKey) yet has a layout.
  layoutPinnedByAgent: boolean;
  currentRevisionId: string | null;
  draftCount: number;
  firstTryApproved: boolean | null;
  awaitingToken: string | null;
  codeSpec: CodeSpecView | null;
  impact: ImpactSummary | null;
  revisions: RevisionView[];
  published: PublishedInfo | null;
};

export type MemoryCard = { id: string; state: string; text: string; scope: string };

export type MessageView = {
  id: string;
  outputId: string | null;
  authorKind: AuthorKind;
  author: string;
  kind: MessageKind;
  body: string;
  revisionId: string | null;
  createdAt: string;
  createdLabel: string;
  // kind memory_suggestion: the note, as it stands now (null when its id
  // can't be resolved).
  memory: MemoryCard | null;
};

export type StepView = {
  id: string;
  outputId: string | null;
  kind: string;
  summary: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: string;
  timeLabel: string;
};

export type RequestView = {
  // Server time the view was built (ms); the client keeps the newest of the
  // page's props and its own polls.
  generatedAt: number;
  admin: boolean;
  id: string;
  ref: string;
  title: string;
  status: RequestStatus;
  source: RequestSource;
  poNumber: string | null;
  message: string;
  requester: string;
  requesterIsViewer: boolean;
  createdLabel: string;
  // Screenshots for the whole request (not tied to one output).
  generalAttachments: AttachmentView[];
  outputs: OutputView[];
  messages: MessageView[];
  steps: StepView[];
};

// ── Labels (server-side formatting; dates via formatDate like the inbox) ─────

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Access ───────────────────────────────────────────────────────────────────

export function canSeeRequest(viewer: ReviewViewer, createdById: string): boolean {
  return isAdmin(viewer.role) || (viewer.role === "REVIEWER" && viewer.userId === createdById);
}

// ── Pure builders ────────────────────────────────────────────────────────────

type RevisionSummaryRow = {
  id: string;
  number: number;
  status: string;
  authorKind: string;
  note: string | null;
  parentRevisionId: string | null;
  publishedVersion: number | null;
  changeRequestOutputId: string | null;
  createdAt: Date;
};

type MemoryRow = { id: string; state: string; text: string; scope: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// The memory a memory_suggestion message is about. The propose_memory tool
// stores it as meta.memoryId (meta.id accepted too).
export function memoryIdOf(meta: unknown): string | null {
  const m = asRecord(meta);
  return m ? (str(m.memoryId) ?? str(m.id)) : null;
}

type MessageRow = RequestDetail["messages"][number];

export function publishedInfoFor(messages: readonly MessageRow[], outputId: string): PublishedInfo | null {
  const mine = messages.filter((m) => m.outputId === outputId && m.authorKind === "SYSTEM");
  const note = [...mine].reverse().find((m) => asRecord(m.meta)?.event === "published");
  if (!note) return null;
  const meta = asRecord(note.meta) ?? {};
  const rerun = asRecord(meta.rerun);
  const sentBack = new Set<string>();
  for (const m of mine) {
    const mm = asRecord(m.meta);
    if (mm?.event === "rerun_approved" && m.createdAt >= note.createdAt && Array.isArray(mm.styleIds)) {
      for (const id of mm.styleIds) if (typeof id === "string") sentBack.add(id);
    }
  }
  return {
    publishedVersion: typeof meta.publishedVersion === "number" ? meta.publishedVersion : null,
    forced: meta.forced === true,
    rerun: rerun
      ? {
          enqueued: num(rerun.enqueued),
          documents: num(rerun.documents),
          skippedNoPo: num(rerun.skippedNoPo),
          skippedBelowCutoff: num(rerun.skippedBelowCutoff),
          skippedInFlight: num(rerun.skippedInFlight),
          error: str(rerun.error),
        }
      : null,
    approvedChanged: num(meta.approvedChanged),
    deliveredChanged: num(meta.deliveredChanged),
    impactError: str(meta.impactError),
    summary: note.body,
    sentBackStyleIds: [...sentBack],
  };
}

function codeSpecView(raw: unknown): CodeSpecView | null {
  const parsed = CodeSpecSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  return {
    tokenKey: s.tokenKey,
    label: s.label,
    rule: s.rule,
    board: s.source.board,
    column: s.source.column,
    cases: s.cases.length,
  };
}

function impactView(raw: unknown): ImpactSummary | null {
  if (raw == null) return null;
  const parsed = ImpactSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function buildRequestView(input: {
  detail: RequestDetail;
  revisions: readonly RevisionSummaryRow[];
  emails: ReadonlyMap<string, string>;
  memories: ReadonlyMap<string, MemoryRow>;
  // layoutId → OutputLayout.name.
  layoutNames?: ReadonlyMap<string, string>;
  viewer: ReviewViewer;
  now?: number;
}): RequestView {
  const { detail, viewer } = input;
  const admin = isAdmin(viewer.role);
  const who = (userId: string | null): string => {
    if (!userId) return "Someone";
    if (userId === viewer.userId) return "You";
    return input.emails.get(userId) ?? "Someone";
  };

  const revisionsByOutput = new Map<string, RevisionView[]>();
  for (const r of [...input.revisions].sort((a, b) => b.number - a.number)) {
    if (!r.changeRequestOutputId) continue;
    const list = revisionsByOutput.get(r.changeRequestOutputId) ?? [];
    list.push({
      id: r.id,
      number: r.number,
      status: r.status,
      authorKind: r.authorKind,
      note: r.note,
      parentRevisionId: r.parentRevisionId,
      publishedVersion: r.publishedVersion,
      createdAt: r.createdAt.toISOString(),
      createdLabel: formatDate(r.createdAt),
    });
    revisionsByOutput.set(r.changeRequestOutputId, list);
  }

  const attachment = (a: RequestDetail["attachments"][number]): AttachmentView => ({
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    byteSize: a.byteSize,
  });

  return {
    generatedAt: input.now ?? Date.now(),
    admin,
    id: detail.id,
    ref: requestRef(detail.number),
    title: detail.title,
    status: detail.status as RequestStatus,
    source: detail.source as RequestSource,
    poNumber: detail.poNumber,
    message: detail.message,
    requester: who(detail.createdById),
    requesterIsViewer: detail.createdById === viewer.userId,
    createdLabel: formatDate(detail.createdAt),
    generalAttachments: detail.attachments.filter((a) => !a.outputId).map(attachment),
    outputs: detail.outputs.map((o) => ({
      id: o.id,
      position: o.position,
      label: o.label,
      variantKey: o.variantKey,
      layoutId: o.layoutId,
      styleId: o.styleId,
      text: o.text,
      status: o.status as OutputStatus,
      attachments: detail.attachments.filter((a) => a.outputId === o.id).map(attachment),
      rejectReason: o.rejectReason,
      publishedLabel: o.publishedAt ? formatDate(o.publishedAt) : null,
      layoutName: o.layoutId ? (input.layoutNames?.get(o.layoutId) ?? null) : null,
      layoutPinnedByAgent: !o.variantKey && !!o.layoutId,
      currentRevisionId: o.currentRevisionId,
      draftCount: o.draftCount,
      firstTryApproved: o.firstTryApproved,
      awaitingToken: o.awaitingToken,
      codeSpec: codeSpecView(o.codeSpec),
      impact: impactView(o.impact),
      revisions: revisionsByOutput.get(o.id) ?? [],
      published: publishedInfoFor(detail.messages, o.id),
    })),
    messages: detail.messages.map((m) => {
      const memoryId = m.kind === "memory_suggestion" ? memoryIdOf(m.meta) : null;
      return {
        id: m.id,
        outputId: m.outputId,
        authorKind: m.authorKind as AuthorKind,
        author: m.authorKind === "AGENT" ? "Assistant" : m.authorKind === "SYSTEM" ? "System" : who(m.authorUserId),
        kind: m.kind as MessageKind,
        body: m.body,
        revisionId: m.revisionId,
        createdAt: m.createdAt.toISOString(),
        createdLabel: formatDate(m.createdAt),
        memory: memoryId ? (input.memories.get(memoryId) ?? null) : null,
      };
    }),
    steps: detail.steps.map((s) => ({
      id: s.id,
      outputId: s.outputId,
      kind: s.kind,
      summary: s.summary,
      model: s.model,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      createdAt: s.createdAt.toISOString(),
      timeLabel: timeLabel(s.createdAt),
    })),
  };
}

// The filing reviewer's view: what they asked, where it stands, the thread.
export function redactForRequester(view: RequestView): RequestView {
  return {
    ...view,
    admin: false,
    outputs: view.outputs.map((o) => ({
      ...o,
      layoutName: null,
      layoutPinnedByAgent: false,
      currentRevisionId: null,
      draftCount: 0,
      firstTryApproved: null,
      awaitingToken: null,
      codeSpec: null,
      impact: null,
      revisions: [],
      published: null,
    })),
    // Other people in the thread are admins; their address isn't the point.
    messages: view.messages
      .filter((m) => m.kind !== "memory_suggestion")
      .map((m) => ({ ...m, memory: null, author: m.authorKind === "USER" && m.author !== "You" ? "Admin" : m.author })),
    steps: [],
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export type LoadRequestViewResult =
  | { ok: true; view: RequestView }
  | { ok: false; reason: "not_found" | "forbidden" };

export async function loadRequestView(id: string, viewer: ReviewViewer): Promise<LoadRequestViewResult> {
  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, reason: "not_found" };
  if (!canSeeRequest(viewer, detail.createdById)) return { ok: false, reason: "forbidden" };
  const admin = isAdmin(viewer.role);

  const outputIds = detail.outputs.map((o) => o.id);
  const userIds = [
    ...new Set([detail.createdById, ...detail.messages.map((m) => m.authorUserId)].filter((v): v is string => !!v)),
  ];
  const memoryIds = admin
    ? [
        ...new Set(
          detail.messages
            .filter((m) => m.kind === "memory_suggestion")
            .map((m) => memoryIdOf(m.meta))
            .filter((v): v is string => !!v),
        ),
      ]
    : [];

  const layoutIds = admin
    ? [...new Set(detail.outputs.map((o) => o.layoutId).filter((v): v is string => !!v))]
    : [];

  const [revisions, users, memories, layouts] = await Promise.all([
    admin && outputIds.length > 0
      ? orEmpty(
          db.outputLayoutRevision.findMany({
            where: { changeRequestOutputId: { in: outputIds } },
            orderBy: { number: "desc" },
            select: {
              id: true,
              number: true,
              status: true,
              authorKind: true,
              note: true,
              parentRevisionId: true,
              publishedVersion: true,
              changeRequestOutputId: true,
              createdAt: true,
            },
          }),
          [] as RevisionSummaryRow[],
        )
      : Promise.resolve([] as RevisionSummaryRow[]),
    userIds.length > 0
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : Promise.resolve([] as { id: string; email: string }[]),
    memoryIds.length > 0
      ? orEmpty(
          db.agentMemory.findMany({
            where: { id: { in: memoryIds } },
            select: { id: true, state: true, text: true, scope: true },
          }),
          [] as MemoryRow[],
        )
      : Promise.resolve([] as MemoryRow[]),
    layoutIds.length > 0
      ? orEmpty(
          db.outputLayout.findMany({ where: { id: { in: layoutIds } }, select: { id: true, name: true } }),
          [] as { id: string; name: string }[],
        )
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  const view = buildRequestView({
    detail,
    revisions,
    emails: new Map(users.map((u) => [u.id, u.email])),
    memories: new Map(memories.map((m) => [m.id, m])),
    layoutNames: new Map(layouts.map((l) => [l.id, l.name])),
    viewer,
  });
  return { ok: true, view: admin ? view : redactForRequester(view) };
}
