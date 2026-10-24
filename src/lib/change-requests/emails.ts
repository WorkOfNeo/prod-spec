import { db } from "@/lib/db";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import {
  changeRequestUpdateEmail,
  type ChangeRequestUpdateKind,
} from "@/lib/email/templates/change-request-update";
import { requestRef } from "./types";

// =====================================================
// Change requests — emails to the person who filed the request.
//
// Every send goes through dispatchEmail, so RESEND_EMAILS still decides whether
// anything really leaves (off → SIMULATED and logged), and every attempt lands
// in the email activity log.
//
// FAIL-SOFT: an update email is a courtesy on top of a state change that has
// already happened (a request filed, a draft published). A failure here logs
// and returns null; it never throws into the action that triggered it.
//
// Only the requester is ever written to from here. Supplier mail is not a
// change-request concern (design §2, rail 1).
// =====================================================

export type RequesterUpdateKind = ChangeRequestUpdateKind;

export type RequesterUpdateExtra = {
  // The output the update is about (needs_info / live / rejected).
  outputId?: string;
  // The question (needs_info) or the reason (rejected).
  message?: string;
  // Proofs for the "live" email, attached as PNGs.
  beforePng?: Buffer;
  afterPng?: Buffer;
};

function baseUrl(): string {
  return (process.env.PROD_SPEC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function requestUrl(requestId: string): string {
  return `${baseUrl()}/requests/${requestId}`;
}

export async function sendRequesterUpdate(
  requestId: string,
  kind: RequesterUpdateKind,
  extra: RequesterUpdateExtra = {},
): Promise<EmailOutcome | null> {
  try {
    const request = await db.changeRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        number: true,
        title: true,
        poNumber: true,
        styleId: true,
        createdById: true,
        outputs: { orderBy: { position: "asc" }, select: { id: true, label: true, styleId: true } },
      },
    });
    if (!request) {
      console.warn(`[change-requests] requester email (${kind}) skipped — request ${requestId} not found`);
      return null;
    }
    const creator = await db.user.findUnique({ where: { id: request.createdById }, select: { email: true } });
    if (!creator?.email) {
      console.warn(`[change-requests] requester email (${kind}) skipped — no email for the creator of ${requestId}`);
      return null;
    }

    const ref = requestRef(request.number);
    const output = extra.outputId ? request.outputs.find((o) => o.id === extra.outputId) : undefined;
    const attachments: Array<{ filename: string; content: Buffer }> = [];
    if (extra.beforePng) attachments.push({ filename: `${ref}-before.png`, content: extra.beforePng });
    if (extra.afterPng) attachments.push({ filename: `${ref}-after.png`, content: extra.afterPng });

    const email = changeRequestUpdateEmail({
      kind,
      ref,
      title: request.title,
      outputLabel: output?.label ?? null,
      outputLabels: request.outputs.map((o) => o.label),
      poNumber: request.poNumber,
      message: extra.message ?? null,
      requestUrl: requestUrl(request.id),
      hasProofs: attachments.length > 0,
    });

    return await dispatchEmail({
      type: "CHANGE_REQUEST_UPDATE",
      to: creator.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: attachments.length > 0 ? attachments : undefined,
      // Loose ref for the activity log: the style the update is about.
      styleId: output?.styleId ?? request.styleId ?? null,
    });
  } catch (err) {
    console.error(`[change-requests] requester email (${kind}) for ${requestId} failed: ${(err as Error).message}`);
    return null;
  }
}
