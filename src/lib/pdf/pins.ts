import type { StyleData, SiblingStyle } from "./types";
import { computeEan13Checksum, isValidEan13 } from "./barcode";
import { parseFieldOverrides, type PinnableField } from "./pins-meta";

// =====================================================
// Per-output field pins — StyleData application (server side).
//
// The pin vocabulary, labels, parsing and readiness helpers live in
// ./pins-meta (client-safe, no barcode dependency). This module applies a
// sanitised pin map onto a StyleData copy right before a render: the pinned
// value wins over spec value rules, mapped columns, derived resolvers and
// injected fallbacks alike.
// =====================================================

export { PINNABLE_FIELDS, PINNABLE_FIELD_LABELS, parseFieldOverrides, pinnedColumnKeys } from "./pins-meta";
export type { PinnableField } from "./pins-meta";

function ensureValidEan(input: string): string {
  if (!input) return "0000000000000";
  if (isValidEan13(input)) return input;
  if (/^\d{12}$/.test(input)) return computeEan13Checksum(input);
  return "0000000000000";
}

// Apply pins to a StyleData — returns a NEW object (the per-job StyleData is
// shared across outputs; pins are per output). No-ops on an empty map.
export function applyFieldOverrides(style: StyleData, rawOverrides: unknown): StyleData {
  const pins = parseFieldOverrides(rawOverrides);
  const keys = Object.keys(pins) as PinnableField[];
  if (keys.length === 0) return style;

  const next: StyleData = {
    ...style,
    carton: { ...style.carton },
    colour: style.colour ? { ...style.colour } : undefined,
  };
  for (const key of keys) {
    const v = pins[key]!;
    switch (key) {
      case "customerName":
        next.customerName = v;
        break;
      case "styleNumber":
        next.styleNumber = v;
        break;
      case "composition":
        // Pinned composition is treated as the English source line — the
        // same forgiveness rule the mapper applies to un-prefixed entries.
        next.composition = [{ language: "en", text: v }];
        break;
      case "colourName":
        next.colour = { name: v, code: next.colour?.code ?? "" };
        break;
      case "colourCode":
        next.colour = { name: next.colour?.name ?? "", code: v };
        break;
      case "cartonQty":
        next.carton.outerVE = Number(v) || 0;
        break;
      case "cartonEan":
        next.carton.ean13 = ensureValidEan(v);
        break;
      case "klNumber":
        next.carton.klNumber = v;
        break;
      case "lot":
        next.carton.lot = v;
        break;
      case "supplierNumber":
        next.carton.supplierNumber = v;
        break;
      case "customerItemNo":
        next.customerItemNo = v;
        break;
      case "batchNo":
        next.batchNo = v;
        break;
      case "prodNumber":
        next.prodNumber = v;
        break;
      case "description":
        next.description = v;
        break;
      case "campaignWeek":
        next.campaignWeek = v;
        break;
      case "customerOrderNo":
        next.customerOrderNo = v;
        break;
      case "deliveryTerm":
        next.deliveryTerm = v;
        break;
      case "poNumber":
        next.poNumber = v;
        break;
      case "countryOfOrigin":
        next.countryOfOrigin = v;
        break;
    }
  }
  return next;
}

// Read the CURRENT value of a pinnable field from a StyleData — the inverse
// of applyFieldOverrides's write switch. Used to pre-fill the review-time
// field editor with what the output would print right now (so a reviewer edits
// a resolved value in place). Returns "" when the field has no value. For a
// per-document (repeat-per-EAN) render, pass that document's per-row StyleData
// (repetitionStyles output) so colour / carton EAN reflect the specific PDF.
export function readPinnableField(style: StyleData, field: PinnableField): string {
  switch (field) {
    case "customerName":
      return style.customerName ?? "";
    case "styleNumber":
      return style.styleNumber ?? "";
    case "composition":
      // The English source line — mirrors how a pin is written back in.
      return style.composition?.find((c) => c.language === "en")?.text ?? style.composition?.[0]?.text ?? "";
    case "colourName":
      return style.colour?.name ?? "";
    case "colourCode":
      return style.colour?.code ?? "";
    case "cartonQty":
      return style.carton.outerVE ? String(style.carton.outerVE) : "";
    case "cartonEan":
      return style.carton.ean13 ?? "";
    case "klNumber":
      return style.carton.klNumber ?? "";
    case "lot":
      return style.carton.lot ?? "";
    case "supplierNumber":
      return style.carton.supplierNumber ?? "";
    case "customerItemNo":
      return style.customerItemNo ?? "";
    case "batchNo":
      return style.batchNo ?? "";
    case "prodNumber":
      return style.prodNumber ?? "";
    case "description":
      return style.description ?? "";
    case "campaignWeek":
      return style.campaignWeek ?? "";
    case "customerOrderNo":
      return style.customerOrderNo ?? "";
    case "deliveryTerm":
      return style.deliveryTerm ?? "";
    case "poNumber":
      return style.poNumber ?? "";
    case "countryOfOrigin":
      return style.countryOfOrigin ?? "";
  }
}

// Apply the output row's carton-barcode preference (symbology / bar
// height) onto a StyleData copy — same copy-on-write contract as
// applyFieldOverrides (the per-job StyleData is shared across outputs).
// No-op when the row carries no preference, so non-carton outputs and
// legacy rows pass through untouched. The param is typed structurally to
// keep this module decoupled from prod-spec/config.ts.
export function applyCartonBarcodePrefs(
  style: StyleData,
  output: { cartonBarcodeType?: "ean128" | "ean13"; cartonBarcodeHeightMm?: number },
): StyleData {
  if (!output.cartonBarcodeType && !output.cartonBarcodeHeightMm) return style;
  return {
    ...style,
    cartonBarcode: {
      type: output.cartonBarcodeType ?? "ean128",
      heightMm: output.cartonBarcodeHeightMm,
    },
  };
}

// "Custom Carton Marking" is a MANUAL one-off — there is no standing
// per-output config. The carton dialog passes the operator's chosen sibling
// ids (slot order); this turns multi-style mode ON (so {{style2}}+ and
// {{multipleStyles}} resolve) and narrows the pre-fetched POOL to exactly
// those picks. Standard generation never calls this, so it stays
// single-style. Unknown ids are dropped; an empty pick still flips the mode
// flag on (the operator opted in) but fills no sibling slots.
export function withSelectedSiblings(style: StyleData, ids: string[]): StyleData {
  const pool = style.siblings ?? [];
  const byId = new Map(pool.map((s) => [s.id, s]));
  const picked: SiblingStyle[] = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (hit) picked.push(hit);
  }
  return { ...style, siblings: picked, multipleStyles: true };
}
