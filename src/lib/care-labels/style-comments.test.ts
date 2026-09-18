import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStyleCommentCareInstructions as parse } from "./style-comments";

describe("parseStyleCommentCareInstructions", () => {
  // Both live shapes of the Salling block differ only by a trailing space
  // after the colon — neither may change the parsed result.
  const LIVE_WITH_SPACE =
    "TEXT ON LABEL: \nVaskes før brug.\nVaskes med vrangen ud.\nVaskes med lignende farver.\nKrymp max 5%";
  const LIVE_NO_SPACE =
    "TEXT ON LABEL:\nVaskes før brug.\nVaskes med vrangen ud.\nVaskes med lignende farver.\nKrymp max 5%";
  const EXPECTED = [
    "Vaskes før brug.",
    "Vaskes med vrangen ud.",
    "Vaskes med lignende farver.",
    "Krymp max 5%",
  ].join("\n");

  it("parses the live block, one instruction per line", () => {
    assert.equal(parse(LIVE_WITH_SPACE), EXPECTED);
  });

  it("is insensitive to the space after the colon", () => {
    assert.equal(parse(LIVE_NO_SPACE), EXPECTED);
  });

  it("splits on commas as well as newlines", () => {
    assert.equal(
      parse("TEXT ON LABEL: Vaskes før brug., Vaskes med lignende farver."),
      "Vaskes før brug.\nVaskes med lignende farver.",
    );
  });

  it("matches the heading case-insensitively and with odd spacing", () => {
    assert.equal(parse("  text on label :\nVaskes før brug."), "Vaskes før brug.");
  });

  it("capitalizes each instruction, like every other care path", () => {
    assert.equal(parse("TEXT ON LABEL:\nvaskes før brug.\nkrymp max 5%"), "Vaskes før brug.\nKrymp max 5%");
  });

  it("keeps a slash inside a phrase — it is not a separator", () => {
    assert.equal(parse("TEXT ON LABEL:\nWash inside/out"), "Wash inside/out");
  });

  it("drops blank fragments from stray separators", () => {
    assert.equal(parse("TEXT ON LABEL:\n\nVaskes før brug.,,\n  \nKrymp max 5%"), "Vaskes før brug.\nKrymp max 5%");
  });

  // THE GATE. Style Comments is a general production-notes field; only the
  // "TEXT ON LABEL:" convention is label copy. Anything else must resolve
  // empty rather than print internal chatter onto a care label.
  it("resolves empty for ordinary production comments", () => {
    for (const chatter of [
      "Customer requires mock-up for print before production",
      "Info Area: Yes.",
      "Info area- yes, Oeko tex- yes",
      "60% Recycled Cotton, 40% Polyester.",
      "Please provide sales with info on when customer can expect photosamples.",
    ]) {
      assert.equal(parse(chatter), "", `expected empty for: ${chatter}`);
    }
  });

  it("only matches the heading at the START of the value", () => {
    assert.equal(parse("Some note first\nTEXT ON LABEL:\nVaskes før brug."), "");
  });

  it("resolves empty for missing / blank / heading-only values", () => {
    assert.equal(parse(undefined), "");
    assert.equal(parse(null), "");
    assert.equal(parse(""), "");
    assert.equal(parse("   "), "");
    assert.equal(parse("TEXT ON LABEL:"), "");
    assert.equal(parse("TEXT ON LABEL:\n  \n"), "");
  });
});
