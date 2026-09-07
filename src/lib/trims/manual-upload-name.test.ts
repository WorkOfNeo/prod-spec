import { test } from "node:test";
import assert from "node:assert/strict";
import { manualTrimExtension, manualTrimFileName } from "./manual-upload-name";

// The folder these land in ("APPROVED LAYOUTS") is PO-scoped, so every test
// here is really one question: can two rows sharing a PO produce one name?

test("the name reads style, colour, trim, then the style key", () => {
  assert.equal(
    manualTrimFileName({
      styleNumber: "AB10001",
      colour: { name: "Navy Blue" },
      styleKey: "1111111111",
      label: "Main Label with size",
      originalFileName: "whatever the studio called it.pdf",
    }),
    "ab10001-navy-blue-main-label-with-size-1111111111.pdf",
  );
});

test("two styles on ONE PO cannot resolve to the same name", () => {
  // The worst case the PO folder actually produces: the same style number, in
  // the same colourway, for the same trim — two SEPARATE Style rows under one
  // PO. Style number + colour + trim are identical, so only the style key
  // separates them, which is the whole reason it is in the name.
  const shared = {
    styleNumber: "AB10001",
    colour: { name: "Navy Blue" },
    label: "Main Label with size",
    originalFileName: "artwork.pdf",
  };
  const a = manualTrimFileName({ ...shared, styleKey: "1111111111" });
  const b = manualTrimFileName({ ...shared, styleKey: "2222222222" });

  assert.ok(a && b);
  assert.notEqual(a, b);
  // …and both still carry the human-readable half, so the split is not the
  // whole name turning into an opaque id.
  for (const name of [a, b]) {
    assert.ok(name.startsWith("ab10001-navy-blue-main-label-with-size-"));
  }
});

test("differing colourways separate on the colour alone", () => {
  const shared = {
    styleNumber: "AB10001",
    label: "Hangtag",
    originalFileName: "artwork.pdf",
    styleKey: "1111111111",
  };
  assert.notEqual(
    manualTrimFileName({ ...shared, colour: { name: "Navy" } }),
    manualTrimFileName({ ...shared, colour: { name: "Sand" } }),
  );
});

test("two trims on ONE style never share a name", () => {
  const shared = {
    styleNumber: "AB10001",
    colour: { name: "Navy" },
    styleKey: "1111111111",
    originalFileName: "artwork.pdf",
  };
  assert.notEqual(
    manualTrimFileName({ ...shared, label: "Hangtag" }),
    manualTrimFileName({ ...shared, label: "Hanger" }),
  );
});

test("the colour code stands in for a missing colour name, asterisk stripped", () => {
  assert.equal(
    manualTrimFileName({
      styleNumber: "AB10001",
      colour: { name: "", code: "*Blue" },
      styleKey: "1111111111",
      label: "Hangtag",
      originalFileName: "a.pdf",
    }),
    "ab10001-blue-hangtag-1111111111.pdf",
  );
});

test("no colour at all just drops the segment — it never leaves a double dash", () => {
  assert.equal(
    manualTrimFileName({
      styleNumber: "AB10001",
      colour: null,
      styleKey: "1111111111",
      label: "Hangtag",
      originalFileName: "a.pdf",
    }),
    "ab10001-hangtag-1111111111.pdf",
  );
});

test("a label of pure punctuation still yields a segment", () => {
  const name = manualTrimFileName({
    styleNumber: "AB10001",
    colour: null,
    styleKey: "1111111111",
    label: "+++",
    originalFileName: "a.pdf",
  });
  assert.equal(name, "ab10001-trim-1111111111.pdf");
});

test("the name carries no character SharePoint forbids", () => {
  const name = manualTrimFileName({
    styleNumber: "AB/100:01",
    colour: { name: 'Na"vy <blue>' },
    styleKey: "1111111111",
    label: "Polybag w. sticker | 2 pcs?",
    originalFileName: "a.pdf",
  });
  assert.ok(name);
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

test("only the formats we accept produce a name", () => {
  const base = {
    styleNumber: "AB10001",
    colour: null,
    styleKey: "1111111111",
    label: "Hangtag",
  };
  assert.ok(manualTrimFileName({ ...base, originalFileName: "a.PDF" })?.endsWith(".pdf"));
  assert.ok(manualTrimFileName({ ...base, originalFileName: "a.docx" })?.endsWith(".docx"));
  assert.equal(manualTrimFileName({ ...base, originalFileName: "a.exe" }), null);
  assert.equal(manualTrimFileName({ ...base, originalFileName: "no-extension" }), null);
});

test("the extension comes off the NAME, lowercased", () => {
  assert.equal(manualTrimExtension("Artwork.PDF"), "pdf");
  assert.equal(manualTrimExtension("archive.tar.gz"), null);
  assert.equal(manualTrimExtension("spec.XLSX"), "xlsx");
});
