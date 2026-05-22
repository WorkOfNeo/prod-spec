import { toBuffer } from "bwip-js";

export type BarcodeOpts = {
  bcid?: string;
  scale?: number;
  height?: number;
  includetext?: boolean;
  textxalign?: "center" | "left" | "right";
};

const DEFAULTS: Required<Pick<BarcodeOpts, "bcid" | "scale" | "height" | "includetext" | "textxalign">> = {
  bcid: "ean13",
  scale: 3,
  height: 10,
  includetext: true,
  textxalign: "center",
};

export async function renderBarcodePng(text: string, opts: BarcodeOpts = {}): Promise<Buffer> {
  return toBuffer({ ...DEFAULTS, ...opts, text });
}

export async function renderBarcodeDataUrl(text: string, opts: BarcodeOpts = {}): Promise<string> {
  const buf = await renderBarcodePng(text, opts);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// EAN-13 validity check — 13 digits, last is checksum.
export function isValidEan13(input: string): boolean {
  if (!/^\d{13}$/.test(input)) return false;
  const digits = input.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function computeEan13Checksum(twelve: string): string {
  if (!/^\d{12}$/.test(twelve)) throw new Error("EAN-13 base must be exactly 12 digits");
  const digits = twelve.split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return `${twelve}${check}`;
}
