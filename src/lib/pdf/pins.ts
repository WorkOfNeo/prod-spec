import type { StyleData } from "./types";
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
