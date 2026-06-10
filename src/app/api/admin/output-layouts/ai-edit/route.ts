import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { LAYOUT_TOKENS } from "@/lib/output-layouts/token-meta";

export const runtime = "nodejs";
export const maxDuration = 120;

// AI layout editing — "make the title bigger and centered", "add a
// barcode bottom right", "repeat this per EAN". Sends the current
// definition + the operator's prompt to Claude and gets a full updated
// definition back, which is validated with the same zod schema the
// editor and publish gate use before anything is saved.
//
// Key-gated: requires ANTHROPIC_API_KEY in the environment; without it
// the endpoint answers 503 and the editor shows how to enable it.

const BODY_SCHEMA = z.object({
  definition: LayoutDefSchema,
  prompt: z.string().min(1).max(2000),
});

// What the model may produce — mirrors LayoutDefSchema minus constraint
// kinds the structured-outputs grammar doesn't support (min/max bounds
// are enforced afterwards by LayoutDefSchema.parse).
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "widthMm", "heightMm", "blocks"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          widthMm: { type: "number" },
          heightMm: { type: "number" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "rect", "fontPt", "bold", "lineHeight", "lines"],
              properties: {
                id: { type: "string" },
                rect: {
                  type: "object",
                  additionalProperties: false,
                  required: ["col", "row", "colSpan", "rowSpan"],
                  properties: {
                    col: { type: "integer" },
                    row: { type: "integer" },
                    colSpan: { type: "integer" },
                    rowSpan: { type: "integer" },
                  },
                },
                align: { type: "string", enum: ["left", "center", "right"] },
                valign: { type: "string", enum: ["top", "middle", "bottom"] },
                fontPt: { type: "number" },
                bold: { type: "boolean" },
                lineHeight: { type: "number" },
                lines: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    settings: {
      type: "object",
      additionalProperties: false,
      properties: {
        repeatBy: { type: "string", enum: ["none", "ean"] },
        fileName: { type: "string" },
      },
    },
  },
} as const;

function systemPrompt(): string {
  const tokens = LAYOUT_TOKENS.map(
    (t) => `{{${t.key}${t.arg === "lang" ? ":<lang>" : t.arg === "source" ? ":cartonEan|:ean13" : ""}}} — ${t.label}`,
  ).join("\n");
  return `You edit print-layout definitions for a production-spec app. A layout has pages (physical mm dimensions) and text blocks placed on a 12×12 grid.

Rules:
- Blocks are RECTS on the grid: col/row are 0-based (0–11), col+colSpan ≤ 12, row+rowSpan ≤ 12. align: left|center|right; valign: top|middle|bottom.
- fontPt 4–48 (9 is standard; barcodes/wash-symbol graphics scale with it). lineHeight 1–3. Max 16 blocks/page, 12 pages.
- Block "lines" are printed rows. They may contain variables:
${tokens}
- One-level conditionals inside a line: {{if deliveryTerm == FOB}}…{{else}}…{{endif}} (also !=; comparison is case-insensitive).
- settings.repeatBy "ean" repeats the whole layout once per size/EAN row; settings.fileName names the output file (text variables allowed, no extension).
- Keep existing ids for blocks/pages you keep; new ones get fresh short ids. Preserve everything the instruction doesn't ask to change.

Return the COMPLETE updated definition.`;
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI editing is not configured — set ANTHROPIC_API_KEY in the environment and restart." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { definition, prompt } = parsed.data;

  const client = new Anthropic();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt(),
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `Current layout definition:\n${JSON.stringify(definition, null, 2)}\n\n` +
            `Instruction: ${prompt}`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Claude API error: ${err.message}` }, { status: 502 });
    }
    throw err;
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  let updated: unknown;
  try {
    updated = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "AI returned unparsable output — try rephrasing." }, { status: 422 });
  }

  const validated = LayoutDefSchema.safeParse(updated);
  if (!validated.success) {
    return NextResponse.json(
      { error: "AI produced an invalid layout", details: validated.error.issues.map((i) => i.message).slice(0, 5) },
      { status: 422 },
    );
  }

  return NextResponse.json({ definition: validated.data });
}
