import { db } from "@/lib/db";
import { emailFromAddress, sendEmail, type SendOpts } from "@/lib/email/client";
import type { EmailStatus, EmailType } from "@/generated/prisma/enums";

// =====================================================
// Flag-aware email dispatch. EVERY outbound email goes through here:
//
//   RESEND_EMAILS === "true"  → really sent via Resend (SENT / FAILED)
//   anything else             → SIMULATED: nothing leaves the building;
//                               the full email is recorded and returned so
//                               the UI can show "this is what WOULD have
//                               been sent" as a popup.
//
// Either way an EmailLog row is written — the activity table on
// /settings/notifications is the only place background sends (webhook /
// cron generations) surface while the flag is off, since they have no UI
// to pop anything up in. Attachment BYTES are never persisted, only
// { filename, bytes } metadata; the PDFs already live in job_assets.
// =====================================================

export function emailSendingEnabled(): boolean {
  return process.env.RESEND_EMAILS === "true";
}

export type EmailAttachmentMeta = { filename: string; bytes: number };

// Returned to callers (and forwarded to the client as JSON) so interactive
// triggers can pop the simulation dialog. htmlPreview is the full body —
// a few KB of template HTML.
export type EmailOutcome = {
  status: EmailStatus;
  type: EmailType;
  to: string;
  cc: string | null;
  from: string; // resolved sender (override or the prodspec@ default)
  subject: string;
  attachments: EmailAttachmentMeta[];
  htmlPreview: string;
  note: string | null;
  emailLogId: string | null;
};

export type DispatchInput = SendOpts & {
  type: EmailType;
  jobId?: string | null;
  styleId?: string | null;
  ticketId?: string | null;
  // Manual real-send: skip the RESEND_EMAILS gate for THIS email only
  // (the "Send for real" action in the email dialog). Everything else —
  // logging, SKIPPED-when-unconfigured, failure capture — works the same.
  force?: boolean;
};

export async function dispatchEmail(input: DispatchInput): Promise<EmailOutcome> {
  const to = joinAddresses(input.to);
  const cc = joinAddresses(input.cc) || null;
  const attachments: EmailAttachmentMeta[] = (input.attachments ?? []).map((a) => ({
    filename: a.filename,
    bytes: a.content.byteLength,
  }));

  let status: EmailStatus;
  let note: string | null = null;
  let providerId: string | null = null;
  let error: string | null = null;

  if (!to) {
    status = "SKIPPED";
    note = "No recipient resolved — nothing to send.";
  } else if (!emailSendingEnabled() && !input.force) {
    status = "SIMULATED";
    note = "RESEND_EMAILS is off — nothing was sent. This is what would have gone out.";
  } else if (!process.env.RESEND_API_KEY) {
    // Distinct from SIMULATED so misconfiguration can't masquerade as
    // intentional dry-run: the operator turned sending ON but Resend
    // can't actually deliver. (The from-address always resolves — it
    // defaults to prodspec@contrast.dk, see emailFromAddress().)
    status = "SKIPPED";
    note = `${input.force ? "Manual send attempted" : "RESEND_EMAILS=true"} but RESEND_API_KEY is not configured — email NOT sent.`;
  } else {
    try {
      const result = await sendEmail({
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments: input.attachments,
        from: input.from,
      });
      status = "SENT";
      providerId = result.id ?? null;
      if (input.force && !emailSendingEnabled()) {
        note = "Sent manually while RESEND_EMAILS is off.";
      }
    } catch (err) {
      status = "FAILED";
      error = (err as Error).message;
      note = `Send failed: ${error}`;
    }
  }

  let emailLogId: string | null = null;
  try {
    const row = await db.emailLog.create({
      data: {
        type: input.type,
        status,
        to,
        cc,
        subject: input.subject,
        html: input.html,
        text: input.text ?? null,
        attachments,
        providerId,
        error,
        jobId: input.jobId ?? null,
        styleId: input.styleId ?? null,
        ticketId: input.ticketId ?? null,
      },
      select: { id: true },
    });
    emailLogId = row.id;
  } catch (err) {
    // The log row is bookkeeping — a write failure must not turn a sent
    // email into a thrown approve/fix request.
    console.error(`[email] failed to write email_logs row: ${(err as Error).message}`);
  }

  return {
    status,
    type: input.type,
    to,
    cc,
    from: input.from?.trim() || emailFromAddress(),
    subject: input.subject,
    attachments,
    htmlPreview: input.html,
    note,
    emailLogId,
  };
}

function joinAddresses(value: string | string[] | undefined): string {
  if (!value) return "";
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => v.trim())
    .filter(Boolean)
    .join(", ");
}
