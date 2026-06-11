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

// "You've been invited to Prod Spec" — sent (or simulated) when an admin
// creates/resends an invite on /users. The link is single-use and locked
// to the recipient's email; it dies the moment someone signs up with it.
export function inviteEmail(input: {
  link: string;
  role: string;
  invitedByName?: string | null;
  expiresAtLabel: string;
}): { subject: string; html: string; text: string } {
  const subject = "You've been invited to Prod Spec";
  const who = input.invitedByName ? `${input.invitedByName} has invited you` : "You've been invited";
  const roleLabel = input.role === "ADMIN" ? "an admin" : "a reviewer";
  const text = [
    `${who} to Prod Spec, Contrast Company's internal production-spec tool.`,
    "",
    `Accept the invitation (you'll join as ${roleLabel}):`,
    input.link,
    "",
    `The link is personal and single-use, and expires ${input.expiresAtLabel}.`,
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">Prod Spec</h2>
      <p style="color: #444; margin: 0 0 12px;">${escapeHtml(who)} to Prod Spec, Contrast Company's internal production-spec tool. You'll join as <strong>${escapeHtml(roleLabel)}</strong>.</p>
      ${ctaButton(input.link, "Accept invitation")}
      <p style="color: #666; font-size: 13px; margin-top: 16px;">Or paste this link into your browser:<br>
        <a href="${input.link}" style="color: #1d4ed8; word-break: break-all;">${escapeHtml(input.link)}</a></p>
      <p style="color: #999; font-size: 12px; margin-top: 16px;">The link is personal and single-use, and expires ${escapeHtml(input.expiresAtLabel)}. If you weren't expecting this, you can ignore this email.</p>
    </div>
  `;
  return { subject, html, text };
}
