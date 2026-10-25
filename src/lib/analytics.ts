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
// Every event also carries the signed-in user's `role`: analyticsOS keeps
// identify traits on the identify event only, so without it no other event
// could be split by role.
//
// One event per OUTPUT (or pushed file), bulk included: a widget counts events
// and can't sum a prop, so a single "approved 12" event would read as 1.
//
// The events, so the names stay consistent:
//   output_approved / output_rejected / output_ignored  { scope }  one per output
//   review_completed       { outcome }  the decision that settled the job
//   supplier_files_pushed  { scope }  one per file
//   output_lines_edited    { lines, all_documents }
//   outputs_regenerated    { scope, count }  one per run
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

type Props = Record<string, string | number | boolean>;

let currentRole: string | null = null;

// Called by AnalyticsIdentify (admin layout) — internal user id + role only,
// never the email or name.
export function identifyUser(userId: string, role: string | null) {
  currentRole = role ?? "NONE";
  if (typeof window === "undefined") return;
  window.aos?.("identify", userId, { role: currentRole });
}

// Sign-out: the next person on this browser starts as a new visitor.
export function resetUser() {
  currentRole = null;
  if (typeof window === "undefined") return;
  window.aos?.("reset");
}

export function track(name: AnalyticsEvent, props?: Props) {
  if (typeof window === "undefined") return;
  window.aos?.("track", name, currentRole ? { role: currentRole, ...props } : props);
}

// The job-settling decision: the per-asset approve / reject / ignore routes
// answer `settled` when that decision closed the job (APPROVED = it published).
export function trackSettled(settled: "APPROVED" | "REJECTED" | undefined) {
  if (settled) track("review_completed", { outcome: settled === "APPROVED" ? "approved" : "rejected" });
}
