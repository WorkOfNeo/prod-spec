import type { DocType } from "@/generated/prisma/enums";
import type { StyleData } from "./types";
import { renderPdf } from "./renderer";
import { renderWashcareHtml } from "./templates/washcare";
import { renderStickerHtml } from "./templates/sticker";
import { renderCartonMarkingHtml } from "./templates/carton-marking";
import { renderColourStickerHtml } from "./templates/colour-sticker";

export type GeneratedDoc = {
  docType: DocType;
  fileName: string;
  pdf: Buffer;
};

export const PHASE_1_DOC_TYPES: DocType[] = ["WASHCARE", "STICKER", "CARTON_MARKING", "COLOUR_STICKER"];

export async function generateDoc(docType: DocType, style: StyleData): Promise<GeneratedDoc> {
  const html = await renderHtmlForDoc(docType, style);
  const pdf = await renderPdf({ html });
  return { docType, fileName: fileNameFor(docType, style), pdf };
}

export async function generateAllDocs(
  style: StyleData,
  docTypes: readonly DocType[] = PHASE_1_DOC_TYPES,
): Promise<GeneratedDoc[]> {
  const docs: GeneratedDoc[] = [];
  for (const docType of docTypes) {
    docs.push(await generateDoc(docType, style));
  }
  return docs;
}

async function renderHtmlForDoc(docType: DocType, style: StyleData): Promise<string> {
  switch (docType) {
    case "WASHCARE":
      return renderWashcareHtml(style);
    case "STICKER":
      return renderStickerHtml(style);
    case "CARTON_MARKING":
      return renderCartonMarkingHtml(style);
    case "COLOUR_STICKER":
      return renderColourStickerHtml(style);
  }
}

function fileNameFor(docType: DocType, style: StyleData): string {
  const slug = style.styleNumber.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const stem = docType.toLowerCase().replace(/_/g, "-");
  return `${slug}-${stem}.pdf`;
}
