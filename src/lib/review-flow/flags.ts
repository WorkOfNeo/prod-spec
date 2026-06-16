// Kill switch for the TEST-PHASE review follow-through machinery: the
// review-page claim popup + "in review" chip, the leave guard, the
// My tasks dashboard (+ sidebar badge + landing redirect). It exists to
// verify PDFs generate correctly while the pipeline earns trust; once it
// has, set REVIEW_FOLLOW_THROUGH_DISABLED=true and the app reverts to the
// plain /styles workflow with no nagging.
//
// Default is ON (flag unset). Server-side only — components receive the
// resolved boolean as props; never read process.env in client code.
//
// Deliberately NOT gated: the approve/reject/publish flow itself (that is
// the product, not the test harness) and the UserNotification producers
// (rows are invisible while the dashboard is off, auto-resolve keeps them
// honest, and history is intact if the flag comes back on).
export function reviewFollowThroughEnabled(): boolean {
  return process.env.REVIEW_FOLLOW_THROUGH_DISABLED !== "true";
}

// Per-output supplier delivery (per-output refactor, phase 3). OFF by default:
// when enabled, approving a SINGLE output notifies the supplier of that output
// (and skips the job-level "publish everything"). Turn on only after the
// output_deliveries table is deployed (npm run db:deploy). Even when ON, the
// email kill switch in src/lib/email/dispatch.ts still blocks real sends — so
// during the test phase this stages previews, never delivers.
export function perOutputDeliveryEnabled(): boolean {
  return process.env.PER_OUTPUT_DELIVERY_ENABLED === "true";
}
