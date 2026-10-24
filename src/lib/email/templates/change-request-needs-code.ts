import { escapeHtml } from "@/lib/pdf/templates/base";
import { requestRef } from "@/lib/change-requests/types";

// "A change request needs a new layout variable" — sent to the developer
// (CHANGE_REQUEST_DEVELOPER_EMAIL, else every admin) by the agent's
// declare_gap tool (src/lib/change-requests/gap.ts). The agent stopped
// instead of guessing data into a layout; this says what to print, where the
// value lives on Monday (with the live values it found) and links the build
// prompt to paste into a coding agent. Same inline-styled card as the other
// notification templates.

function ctaButton(href: string, label: string): string {
  return `
      <p style="margin-top: 24px;">
        <a href="${escapeHtml(href)}"
           style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">
           ${escapeHtml(label)}
        </a>
      </p>`;
}

// Enough to recognise the column; the full list is in the build prompt.
const MAX_EXAMPLES = 8;

export function changeRequestNeedsCodeEmail(input: {
  tokenKey: string;
  label: string;
  rule: string;
  source: { board: string; column: string; examples: Array<{ value: string; count: number }> };
  requestNumber: number;
  outputLabel: string;
  layoutName?: string | null;
  buildPromptUrl: string;
}): { subject: string; html: string; text: string } {
  const ref = requestRef(input.requestNumber);
  const token = `{{${input.tokenKey}}}`;
  const subject = `Variable needed: ${token} · blocks ${ref} (${input.outputLabel})`;
  const examples = [...input.source.examples].sort((a, b) => b.count - a.count);
  const shown = examples.slice(0, MAX_EXAMPLES);
  const more = examples.length - shown.length;
  const onLayout = input.layoutName ? ` on the layout "${input.layoutName}"` : "";

  const rows: Array<[string, string]> = [
    ["Request", `${ref} · ${input.outputLabel}`],
    ["Variable", token],
    ["Board", input.source.board],
    ["Column", input.source.column],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 12px 4px 0; color: #666;">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
    )
    .join("\n        ");

  const examplesHtml =
    shown.length > 0
      ? `
      <table style="margin: 4px 0 0; border-collapse: collapse; font-size: 13px;">
        ${shown
          .map(
            (e) =>
              `<tr><td style="padding: 3px 12px 3px 0; color: #52525b;">${escapeHtml(e.value)}</td><td style="padding: 3px 0; color: #a1a1aa; white-space: nowrap;">× ${e.count}</td></tr>`,
          )
          .join("\n        ")}
      </table>${more > 0 ? `\n      <p style="margin: 4px 0 0; color: #a1a1aa; font-size: 12px;">…and ${more} more in the build prompt.</p>` : ""}`
      : `<p style="margin: 4px 0 0; color: #a1a1aa; font-size: 13px;">No live values were recorded.</p>`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 480px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">Variable needed: ${escapeHtml(token)}</h2>
      <p style="color: #444; margin: 0 0 12px;">${escapeHtml(ref)} (${escapeHtml(input.outputLabel)}) needs a value no layout variable can print yet, so the agent stopped and wrote you a build prompt.</p>
      <table style="margin: 12px 0; border-collapse: collapse;">
        ${rowsHtml}
      </table>
      <h3 style="margin: 20px 0 6px; font-size: 15px;">What to print</h3>
      <p style="margin: 0; color: #444;"><strong>${escapeHtml(input.label)}</strong></p>
      <p style="margin: 4px 0 0; color: #444; white-space: pre-wrap;">${escapeHtml(input.rule)}</p>
      <h3 style="margin: 20px 0 6px; font-size: 15px;">Where it comes from</h3>
      <p style="margin: 0; color: #444;">${escapeHtml(input.source.board)} › ${escapeHtml(input.source.column)}. Live values on active styles:</p>
      ${examplesHtml}
      <h3 style="margin: 20px 0 6px; font-size: 15px;">Why a variable</h3>
      <p style="margin: 0; color: #444;">The agent only changes layouts${escapeHtml(onLayout)}; it never guesses data into one. A variable reads the value per style, so every label prints its own number and a blank value can hide the line.</p>
      ${ctaButton(input.buildPromptUrl, "Get build prompt")}
      <p style="color: #999; font-size: 12px; margin-top: 16px;">When the variable is merged and deployed, Prod-Spec picks ${escapeHtml(ref)} up again by itself.</p>
    </div>
  `;

  const text = [
    `${ref} (${input.outputLabel}) needs a value no layout variable can print yet, so the agent stopped and wrote you a build prompt.`,
    "",
    `Variable: ${token}`,
    `What to print: ${input.label}`,
    input.rule,
    "",
    `Where it comes from: ${input.source.board} › ${input.source.column}`,
    ...(shown.length > 0
      ? ["Live values on active styles:", ...shown.map((e) => `- ${e.value} × ${e.count}`)]
      : ["No live values were recorded."]),
    ...(more > 0 ? [`…and ${more} more in the build prompt.`] : []),
    "",
    `Why a variable: the agent only changes layouts${onLayout}; it never guesses data into one.`,
    "",
    `Get build prompt: ${input.buildPromptUrl}`,
    "",
    `When the variable is merged and deployed, Prod-Spec picks ${ref} up again by itself.`,
  ].join("\n");

  return { subject, html, text };
}
