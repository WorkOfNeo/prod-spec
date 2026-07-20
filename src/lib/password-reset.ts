import { AsyncLocalStorage } from "node:async_hooks";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import { passwordResetEmail } from "@/lib/email/templates/password-reset";

// =====================================================
// Password reset plumbing shared by the two entry points:
//
//   1. self-service — /forgot-password → authClient.requestPasswordReset
//   2. admin-sent   — "Send reset link" on /users → POST
//                     /api/admin/users/[id]/send-reset
//
// Both land in the SAME better-auth endpoint (/api/auth/request-password-reset),
// so the token rules live in one place: better-auth mints a single-use
// `reset-password:<token>` row in `verifications`, and spending it deletes
// that row and (via revokeSessionsOnPasswordReset) kills every session the
// user had. Nothing here mints or validates tokens by hand.
// =====================================================

// Long enough that an admin can send a link to someone who isn't at their
// desk, short enough that a forwarded/leaked mailbox isn't a standing key.
export const RESET_TOKEN_TTL_SECONDS = 60 * 60 * 2;
export const RESET_TOKEN_TTL_LABEL = "2 hours";

function appBaseUrl(): string {
  return (
    process.env.PROD_SPEC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

// Where better-auth bounces the user after it has validated the token —
// our own page, which then posts the new password back. Passed as
// `redirectTo`; without it the callback has nowhere to go and errors out.
export function resetPasswordRedirectTo(): string {
  return `${appBaseUrl()}/reset-password`;
}

// The admin route wants two things better-auth's endpoint doesn't return:
// the EmailOutcome (to pop the simulation dialog while RESEND_EMAILS is off)
// and the link itself (to copy-paste when email isn't an option). Rather
// than duplicate token minting, the route runs the call inside this store
// and the sendResetPassword hook drops both in on its way past.
//
// Safe because better-auth AWAITS sendResetPassword: runInBackgroundOrAwait
// only detaches when advanced.backgroundTasks.handler is configured, and we
// don't configure one (verified against better-auth 1.6.11,
// dist/context/create-context.mjs). No handler → plain await → the store is
// still ours when the hook writes to it.
export type ResetCapture = { outcome?: EmailOutcome; link?: string };

export const resetCapture = new AsyncLocalStorage<ResetCapture>();

// The sendResetPassword hook body (see src/lib/auth.ts). `url` is
// better-auth's own callback URL — it carries the token and redirects on to
// resetPasswordRedirectTo() once validated, so this is what gets emailed.
export async function sendPasswordResetEmail(input: {
  to: string;
  name?: string | null;
  url: string;
}): Promise<EmailOutcome> {
  const capture = resetCapture.getStore();
  const email = passwordResetEmail({
    link: input.url,
    name: input.name,
    expiresInLabel: RESET_TOKEN_TTL_LABEL,
    sentByAdmin: Boolean(capture),
  });
  const outcome = await dispatchEmail({
    type: "PASSWORD_RESET",
    to: input.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (capture) {
    capture.outcome = outcome;
    capture.link = input.url;
  }
  return outcome;
}
