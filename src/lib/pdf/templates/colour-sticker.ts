import type { StyleData } from "../types";
import { escapeHtml, htmlDocument } from "./base";

export async function renderColourStickerHtml(style: StyleData): Promise<string> {
  const colourName = style.colour?.name ?? "—";
  const colourCode = style.colour?.code ?? "—";

  const body = `
    <div class="page" style="text-align: center;">
      <div class="label">${escapeHtml(style.customerName)}</div>
      <h1 style="margin-top: 8pt;">${escapeHtml(colourName)}</h1>
      <div class="small" style="margin-top: 2pt;">Code ${escapeHtml(colourCode)}</div>
      <div style="margin-top: 12pt; font-size: 9pt;">
        Style ${escapeHtml(style.styleNumber)} · ${escapeHtml(style.styleName)}
      </div>
      <div style="margin-top: 8pt; font-size: 8pt;">
        Sizes: ${style.sizes.map((s) => escapeHtml(s.label)).join(", ")}
      </div>
    </div>
  `;

  return htmlDocument({ title: `Colour — ${style.styleName}`, body, pageSize: "A7" });
}
