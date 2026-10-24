import type { ImpactReviewStatus, ImpactRow } from "@/lib/change-requests/types";
import type { MessageView, OutputView, RequestView, StepView } from "@/lib/change-requests/review-view";

// Small client-safe helpers shared by the review screen's components: the one
// fetch wrapper every action uses (JSON in, { ok, status, data } out, never
// throws), view selectors and number formatting. No server imports.

export type ApiResult<T = Record<string, unknown>> = { ok: boolean; status: number; data: T };

export async function sendJson<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PATCH",
  body: unknown = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: err instanceof Error ? err.message : "Network error" } as T };
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, status: 0, data: { error: err instanceof Error ? err.message : "Network error" } as T };
  }
}

export function errorOf(data: unknown, fallback = "Something went wrong"): string {
  const e = (data as { error?: unknown } | null)?.error;
  return typeof e === "string" && e ? e : fallback;
}

// Messages for one output tab: its own plus the request-wide ones.
export function messagesFor(view: RequestView, outputId: string): MessageView[] {
  return view.messages.filter((m) => m.outputId === outputId || m.outputId === null);
}

export function stepsFor(view: RequestView, outputId: string): StepView[] {
  return view.steps.filter((s) => s.outputId === outputId);
}

// The steps of the run in progress (since the last run_start).
export function currentRunSteps(steps: readonly StepView[]): StepView[] {
  let start = 0;
  steps.forEach((s, i) => {
    if (s.kind === "run_start") start = i;
  });
  return steps.slice(start);
}

export function latest<T>(list: readonly T[], pred: (x: T) => boolean): T | null {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return null;
}

// The question the agent is waiting on for this output, if any.
export function openQuestion(messages: readonly MessageView[], outputId: string): MessageView | null {
  return latest(messages, (m) => m.outputId === outputId && m.kind === "question");
}

// The agent's last word on this output: its latest question or reply. An
// output in review with no draft is either waiting on an answer (a question)
// or the agent finished without proposing a change and said why (a message).
export function latestAgentWord(messages: readonly MessageView[], outputId: string): MessageView | null {
  return latest(
    messages,
    (m) => m.outputId === outputId && m.authorKind === "AGENT" && (m.kind === "question" || m.kind === "message"),
  );
}

export function currentRevision(output: OutputView) {
  return output.revisions.find((r) => r.id === output.currentRevisionId) ?? null;
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function count(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

// What a live output can still send back to review, per style (the published
// panel). From the impact the approval stored:
//   • approvedChanged — approved documents the change altered (never rerun by
//     the approval, design §2 rail 3);
//   • held — changed documents, not approved, that the approval HELD because
//     the style has an approved document of this output: a scoped rerun
//     regenerates every document of the output for the style, so it would
//     have sent that approved one back too (publish.ts planScopedRerun);
//   • approvedSiblings — the style's other approved documents of the output,
//     which go back to review with them.
// Styles with nothing changed to send back are left out.
export type SendBackStyle = {
  styleId: string;
  label: string;
  poNumber: string | null;
  approvedChanged: ImpactRow[];
  held: ImpactRow[];
  approvedSiblings: ImpactRow[];
  delivered: boolean;
};

export function sendBackStyles(rows: readonly ImpactRow[]): SendBackStyle[] {
  const byStyle = new Map<string, ImpactRow[]>();
  for (const r of rows) byStyle.set(r.styleId, [...(byStyle.get(r.styleId) ?? []), r]);
  const out: SendBackStyle[] = [];
  for (const [styleId, docs] of byStyle) {
    const approved = docs.filter((d) => d.reviewStatus === "APPROVED");
    if (approved.length === 0) continue;
    const approvedChanged = approved.filter((d) => d.changed);
    const held = docs.filter((d) => d.changed && d.reviewStatus !== "APPROVED");
    if (approvedChanged.length + held.length === 0) continue;
    out.push({
      styleId,
      label: docs[0].styleLabel,
      poNumber: docs[0].poNumber,
      approvedChanged,
      held,
      approvedSiblings: approved.filter((d) => !d.changed),
      delivered: docs.some((d) => d.changed && (d.uploaded || d.emailed)),
    });
  }
  return out;
}

// The second confirmation, in plain words: what sending these styles back
// reruns, and which approved documents go back to review with it.
export function sendBackConfirmText(styles: readonly SendBackStyle[]): string {
  const sum = (pick: (s: SendBackStyle) => readonly unknown[]) => styles.reduce((n, s) => n + pick(s).length, 0);
  const approved = sum((s) => s.approvedChanged);
  const held = sum((s) => s.held);
  const siblings = sum((s) => s.approvedSiblings);
  const what = [
    approved > 0 ? `${plural(approved, "approved document")} that changed` : null,
    held > 0 ? plural(held, "held document") : null,
  ].filter((x): x is string => x !== null);
  const parts = [
    `Send ${plural(styles.length, "style")} back to review?`,
    what.length > 0 ? `This regenerates ${what.join(" and ")} with the new layout.` : null,
    siblings > 0
      ? `${plural(siblings, "other approved document")} of this output on ${
          styles.length === 1 ? "that style" : "those styles"
        } ${siblings === 1 ? "goes" : "go"} back to review too, because a rerun regenerates every document of the output for the style.`
      : null,
    "Nothing reaches a supplier until someone approves them again.",
  ];
  return parts.filter(Boolean).join(" ");
}

export const REVIEW_STATUS_LABEL: Record<ImpactReviewStatus, string> = {
  PENDING_REVIEW: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  NONE: "Never generated",
};

// The document part of an impact row's key ("layout:<id>#M-Black" → "M-Black").
export function docSuffix(variantKey: string): string | null {
  const at = variantKey.indexOf("#");
  return at >= 0 ? variantKey.slice(at + 1) : null;
}

export function attachmentUrl(requestId: string, attachmentId: string): string {
  return `/api/admin/change-requests/${requestId}/attachments/${attachmentId}`;
}

export function proofUrl(revisionId: string, styleId: string, side: "before" | "after", suffix: string | null): string {
  const q = new URLSearchParams({ styleId, side });
  if (suffix !== null) q.set("suffix", suffix);
  return `/api/admin/change-requests/revisions/${revisionId}/proof?${q.toString()}`;
}
