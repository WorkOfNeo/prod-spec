// Minimal ambient declaration to bridge bwip-js's conditional exports
// (the package ships proper types under the `node` condition, but
// moduleResolution: bundler doesn't always resolve them).
declare module "bwip-js" {
  export interface RenderOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    width?: number;
    includetext?: boolean;
    textxalign?: "center" | "left" | "right" | "justify" | "above" | "below";
    backgroundcolor?: string;
    [key: string]: unknown;
  }
  export function toBuffer(opts: RenderOptions): Promise<Buffer>;
  export function toBuffer(opts: RenderOptions, cb: (err: Error | null, png: Buffer) => void): void;
}
