// analyticsOS custom events — business moments the script can't see as a
// click or a page view. Call `track` only AFTER the server confirmed the action
// (res.ok), never on the button press. A no-op when the script isn't loaded
// (no NEXT_PUBLIC_ANALYTICS_KEY) or on the server.
//
// Names: snake_case, object then past-tense verb, stable — reports group by
// name, so no ids or dates in it. Props: a few short values to break the event
// down. Never personal data, free text (a reject comment), style/PO numbers or
// anything else that identifies a person or an order.
//
// The events, so the names stay consistent:
//   output_approved / output_rejected / output_ignored  { scope, count }
//   review_completed       { outcome }  the decision that settled the job
//   supplier_files_pushed  { scope, count }
//   output_lines_edited    { lines, all_documents }
//   outputs_regenerated    { scope, count }
//   bulk_run_started       { mode, styles }

declare global {
  interface Window {
    aos?: (...args: unknown[]) => void;
  }
}

export type AnalyticsEvent =
  | "output_approved"
  | "output_rejected"
  | "output_ignored"
  | "review_completed"
  | "supplier_files_pushed"
  | "output_lines_edited"
  | "outputs_regenerated"
  | "bulk_run_started";

export function track(name: AnalyticsEvent, props?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  window.aos?.("track", name, props);
}

// The job-settling decision: the per-asset approve / reject / ignore routes
// answer `settled` when that decision closed the job (APPROVED = it published).
export function trackSettled(settled: "APPROVED" | "REJECTED" | undefined) {
  if (settled) track("review_completed", { outcome: settled === "APPROVED" ? "approved" : "rejected" });
}
