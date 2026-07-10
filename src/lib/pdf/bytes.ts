// Copy a Node Buffer into a plain `Uint8Array<ArrayBuffer>` — the exact shape
// Prisma's `Bytes` columns accept. A Buffer is a Uint8Array, but its backing
// store is typed `ArrayBufferLike` (it can be a SharedArrayBuffer), which
// Prisma's generated types reject; copying through a fresh Uint8Array pins the
// backing store to a plain ArrayBuffer.
export function toPlainBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}
