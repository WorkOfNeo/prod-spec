import type { ImpactReviewStatus } from "@/lib/change-requests/types";
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
