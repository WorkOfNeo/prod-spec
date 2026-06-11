import type { Invite } from "@/generated/prisma/client";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import { inviteEmail } from "@/lib/email/templates/invite";
import { formatDate } from "@/lib/utils";
import { buildInviteLink } from "./invites";

// Send (or simulate — RESEND_EMAILS off) the invitation email. Shared by
// create (?send) and resend. The outcome is returned to the UI so the
// admin sees exactly what went out, or the simulation popup while the
// email flag is off.
export async function sendInviteEmail(
  invite: Invite,
  invitedByName?: string | null,
): Promise<EmailOutcome> {
  const email = inviteEmail({
    link: buildInviteLink(invite.token),
    role: invite.role,
    invitedByName,
    expiresAtLabel: formatDate(invite.expiresAt),
  });
  return dispatchEmail({
    type: "INVITE",
    to: invite.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}
