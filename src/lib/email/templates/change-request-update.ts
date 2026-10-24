import { escapeHtml } from "@/lib/pdf/templates/base";

// =====================================================
// "What happened to the change you asked for" — sent to the person who filed a
// change request (src/lib/change-requests/emails.ts). One template, four
// moments: we got it, we need something from you, it is live, it was not
// changed. Same inline-styled card as the review-notification emails, and every
// version links back to the request page, where the thread and proofs live.
//
// Deliberately plain about what "live" means: the layout changed, and the
// documents it changes go back through normal review — nothing is sent to a
// supplier because a request was approved.
// =====================================================

export type ChangeRequestUpdateKind = "received" | "needs_info" | "live" | "rejected";

function ctaButton(href: string, label: string): string {
  return `
      <p style="margin-top: 24px;">
        <a href="${href}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           ${escapeHtml(label)}
        </a>
      </p>`;
}

function quote(body: string): string {
  return `
      <blockquote style="border-left: 3px solid #e4e4e7; background: #fafafa; padding: 8px 12px; margin: 0 0 4px; color: #52525b; font-size: 13px; border-radius: 0 6px 6px 0; white-space: pre-wrap;">${escapeHtml(body)}</blockquote>`;
}

type Copy = { subject: string; heading: string; lead: string; cta: string; foot: string };

// The words for each moment. `output` is the output's name as it should appear
// in the body — already escaped for the HTML version, raw for the text one.
function copyFor(
  kind: ChangeRequestUpdateKind,
  input: { ref: string; title: string; outputLabel?: string | null; hasProofs?: boolean },
  output: string,
): Copy {
  const about = input.outputLabel ? ` — ${input.outputLabel}` : "";
  switch (kind) {
    case "received":
      return {
        subject: `[Prod Spec] ${input.ref} received — ${input.title}`,
        heading: "We got your change request",
        lead: "An admin looks at every proposed change before anything prints. You'll hear from us when it's live, or if we need something from you.",
        cta: "Open your request",
        foot: "Nothing changes on a print file until an admin approves it.",
      };
    case "needs_info":
      return {
        subject: `[Prod Spec] ${input.ref} — a question about your request${about}`,
        heading: "We need a little more from you",
        lead: `Before we can change ${output}, we need an answer:`,
        cta: "Answer on the request",
        foot: "The change waits until the question is answered.",
      };
    case "live":
      return {
        subject: `[Prod Spec] ${input.ref} is live${about}`,
        heading: "Your change is live",
        lead: `The change to ${output} was approved and published.${input.hasProofs ? " Before and after are attached." : ""}`,
        cta: "See the request",
        foot: "Documents the change affects are regenerated and go through the normal review before they reach a supplier.",
      };
    case "rejected":
      return {
        subject: `[Prod Spec] ${input.ref} was not changed${about}`,
        heading: "This change was not made",
        lead: `An admin decided not to change ${output}.`,
        cta: "See the request",
        foot: "Reply on the request page if something was misunderstood.",
      };
  }
}

export function changeRequestUpdateEmail(input: {
  kind: ChangeRequestUpdateKind;
  // "R-0001"
  ref: string;
  title: string;
  // The output this update is about (needs_info / live / rejected), when known.
  outputLabel?: string | null;
  // Every output on the request — listed on the "received" email.
  outputLabels?: string[];
  poNumber?: string | null;
  // The question (needs_info) or the reason (rejected); a note on the others.
  message?: string | null;
  requestUrl: string;
  // Before/after proofs ride along as attachments (live).
  hasProofs?: boolean;
}): { subject: string; html: string; text: string } {
  const message = input.message?.trim() || null;
  const fallbackOutput = input.kind === "live" ? "the output" : "this output";
  const htmlCopy = copyFor(input.kind, input, input.outputLabel ? escapeHtml(input.outputLabel) : fallbackOutput);
  const textCopy = copyFor(input.kind, input, input.outputLabel ?? fallbackOutput);

  const rows: Array<[string, string]> = [["Request", `${input.ref} · ${input.title}`]];
  if (input.poNumber) rows.push(["Order (PO)", input.poNumber]);
  if (input.kind === "received" && input.outputLabels?.length) rows.push(["Outputs", input.outputLabels.join(", ")]);
  const table = `
      <table style="margin: 12px 0; border-collapse: collapse;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding: 4px 12px 4px 0; color: #666; vertical-align: top;">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
          )
          .join("\n        ")}
      </table>`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${escapeHtml(htmlCopy.heading)}</h2>
      <p style="color: #444; margin: 0 0 12px;">${htmlCopy.lead}</p>
      ${message ? quote(message) : ""}
      ${table}
      ${ctaButton(input.requestUrl, htmlCopy.cta)}
      <p style="color: #999; font-size: 12px; margin-top: 16px;">${escapeHtml(htmlCopy.foot)}</p>
    </div>
  `;

  const text = [
    textCopy.heading,
    "",
    textCopy.lead,
    ...(message ? ["", message] : []),
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    `${textCopy.cta}: ${input.requestUrl}`,
    "",
    textCopy.foot,
  ].join("\n");

  return { subject: textCopy.subject, html, text };
}
