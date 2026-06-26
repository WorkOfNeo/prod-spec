import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeImageDataUrl,
  decodeImageAttachments,
  sanitizeImageName,
  extForMime,
  MAX_IMAGE_BYTES,
} from "./decode-data-url";

// Payloads only need to be valid base64 of the right MIME — the decoder gates
// type + size, it does not parse the image, so a few bytes stand in fine.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const TINY_WEBP = "data:image/webp;base64,UklGRiIAAABXRUJQ";

describe("decodeImageDataUrl", () => {
  it("decodes a PNG data URL to bytes + metadata", () => {
    const r = decodeImageDataUrl(TINY_PNG);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.image.mimeType, "image/png");
      assert.equal(r.image.ext, "png");
      assert.ok(r.image.byteSize > 0);
      assert.equal(r.image.byteSize, r.image.data.byteLength);
    }
  });

  it("maps JPEG and WebP to the right extension", () => {
    const j = decodeImageDataUrl(TINY_JPEG);
    assert.equal(j.ok && j.image.ext, "jpg");
    const w = decodeImageDataUrl(TINY_WEBP);
    assert.equal(w.ok && w.image.ext, "webp");
  });

  it("rejects a non-image data URL", () => {
    assert.equal(decodeImageDataUrl("data:text/plain;base64,aGVsbG8=").ok, false);
  });

  it("rejects a bare string that isn't a data URL", () => {
    assert.equal(decodeImageDataUrl("not a data url").ok, false);
  });

  it("rejects an empty image (zero decoded bytes)", () => {
    const r = decodeImageDataUrl("data:image/png;base64,=");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /empty/i);
  });

  it("rejects an image over the ~5 MB ceiling", () => {
    // All-'A' base64 decodes to that many zero bytes; size it just past the cap.
    const chars = Math.ceil(((MAX_IMAGE_BYTES + 200_000) * 4) / 3 / 4) * 4;
    const r = decodeImageDataUrl(`data:image/png;base64,${"A".repeat(chars)}`);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /too large/i);
  });
});

describe("sanitizeImageName", () => {
  it("returns null for empty / nullish names", () => {
    assert.equal(sanitizeImageName(undefined), null);
    assert.equal(sanitizeImageName(null), null);
    assert.equal(sanitizeImageName("   "), null);
  });

  it("strips path-ish / odd characters but keeps word/dot/dash/space", () => {
    assert.equal(sanitizeImageName("../../etc/passwd"), ".._.._etc_passwd");
    assert.equal(sanitizeImageName("my shot-1.png"), "my shot-1.png");
  });
});

describe("extForMime", () => {
  it("maps known image types", () => {
    assert.equal(extForMime("image/png"), "png");
    assert.equal(extForMime("image/jpeg"), "jpg");
    assert.equal(extForMime("image/webp"), "webp");
    assert.equal(extForMime("image/gif"), "gif");
    assert.equal(extForMime("image/svg+xml"), "svg");
  });

  it("falls back to 'img' for the unknown", () => {
    assert.equal(extForMime("image/tiff"), "img");
  });
});

describe("decodeImageAttachments", () => {
  it("treats undefined as no attachments", () => {
    const r = decodeImageAttachments(undefined);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.attachments.length, 0);
  });

  it("decodes a batch and resolves file names (falling back to image.<ext>)", () => {
    const r = decodeImageAttachments([
      { dataUrl: TINY_PNG, fileName: "front.png" },
      { dataUrl: TINY_JPEG },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.attachments.length, 2);
      assert.equal(r.attachments[0].fileName, "front.png");
      assert.equal(r.attachments[1].fileName, "image.jpg");
    }
  });

  it("fails the whole batch on the first bad attachment", () => {
    const r = decodeImageAttachments([
      { dataUrl: TINY_PNG },
      { dataUrl: "data:text/plain;base64,aGk=" },
    ]);
    assert.equal(r.ok, false);
  });
});
