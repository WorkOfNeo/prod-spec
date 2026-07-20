import { escapeHtml } from "@/lib/pdf/templates/base";

function ctaButton(href: string, label: string): string {
  return `
      <p style="margin-top: 24px;">
        <a href="${href}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           ${escapeHtml(label)}
        </a>
      </p>`;
}

// "Reset your Prod Spec password" — sent (or simulated) both when someone
// asks for it themselves on /forgot-password and when an admin presses
// "Send reset link" on /users. Same link either way: single-use, short-lived,
// and it signs every other session out once it's spent.
export function passwordResetEmail(input: {
  link: string;
  name?: string | null;
  expiresInLabel: string;
  sentByAdmin?: boolean;
}): { subject: string; html: string; text: string } {
  const subject = "Reset your Prod Spec password";
  const greeting = input.name ? `Hi ${input.name},` : "Hi,";
  const lead = input.sentByAdmin
    ? "An admin has sent you a link to set a new password for Prod Spec, Contrast Company's internal production-spec tool."
    : "Someone (hopefully you) asked to reset the password for this Prod Spec account.";
  const text = [
    greeting,
    "",
    lead,
    "",
    "Set a new password:",
    input.link,
    "",
    `The link can only be used once and expires in ${input.expiresInLabel}. Setting a new password signs you out everywhere else.`,
    "",
    "If you weren't expecting this, you can ignore this email — your password stays as it is.",
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">Prod Spec</h2>
      <p style="color: #444; margin: 0 0 4px;">${escapeHtml(greeting)}</p>
      <p style="color: #444; margin: 0 0 12px;">${escapeHtml(lead)}</p>
      ${ctaButton(input.link, "Set a new password")}
      <p style="color: #666; font-size: 13px; margin-top: 16px;">Or paste this link into your browser:<br>
        <a href="${input.link}" style="color: #1d4ed8; word-break: break-all;">${escapeHtml(input.link)}</a></p>
      <p style="color: #999; font-size: 12px; margin-top: 16px;">The link can only be used once and expires in ${escapeHtml(input.expiresInLabel)}. Setting a new password signs you out everywhere else. If you weren't expecting this, you can ignore this email — your password stays as it is.</p>
    </div>
  `;
  return { subject, html, text };
}
