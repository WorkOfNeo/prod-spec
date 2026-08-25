import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLayoutName,
  classifyTrimLabel,
  DEFAULT_TRIM_RULES,
  layoutDocumentSegment,
  normalizeTrimLabel,
  splitCompoundLabel,
  splitTrimsCell,
} from "./classify";

test("normalisation folds case and punctuation drift", () => {
  assert.equal(normalizeTrimLabel("carton Marking"), normalizeTrimLabel("Carton Marking"));
  assert.equal(normalizeTrimLabel("Polybag w. sticker."), "polybag w sticker");
});

test("rule ORDER decides the 1,139-style colour sticker case", () => {
  // "Carton marking- Color sticker" contains "carton marking", so an unordered
  // contains-match calls it a carton marking. It is a colour sticker.
  const { concepts } = classifyTrimLabel("Carton marking- Color sticker");
  assert.deepEqual(concepts, ["COLOUR_STICKER"]);
  // …while the plain label still resolves to the carton marking.
  assert.deepEqual(classifyTrimLabel("carton Marking").concepts, ["CARTON_MARKING"]);
});

test("a compound label yields every concept it names", () => {
  assert.deepEqual(splitCompoundLabel("Hanger & Hangtag"), ["Hanger", "Hangtag"]);
  assert.deepEqual(classifyTrimLabel("Hanger & Hangtag").concepts, ["HANGER", "HANGTAG"]);
  assert.deepEqual(classifyTrimLabel("Hangtag + Banderole").concepts, ["HANGTAG", "BANDEROLE"]);
  assert.deepEqual(classifyTrimLabel("Polybag + Inlaycard + Hangtag").concepts, [
    "POLYBAG",
    "INFO_AREA",
    "HANGTAG",
  ]);
});

test("Monday vocabulary and layout names meet on the same concept", () => {
  // The pair from the ticket that has almost no token overlap.
  assert.deepEqual(classifyTrimLabel("Wash Care Label with Oeko-tex Logo").concepts, ["CARE_LABEL"]);
  assert.equal(classifyLayoutName("Coop DK - Private Label - Care Label"), "CARE_LABEL");
  assert.equal(classifyLayoutName("Netto DE - RedGreen - Wash Care Label"), "CARE_LABEL");
  assert.equal(classifyLayoutName("Spar Kjøp - Loved - Hang Tag"), "HANGTAG");
  assert.deepEqual(classifyTrimLabel("Hangtag").concepts, ["HANGTAG"]);
});

test("layout names classify on the trailing document segment only", () => {
  assert.equal(layoutDocumentSegment("Coop DK - Private Label - Care Label"), "Care Label");
  // The customer segment must not decide: a customer named after a document
  // would otherwise classify every one of its layouts the same way.
  assert.equal(layoutDocumentSegment("Hangtag AS - License - Wash Care Label"), "Wash Care Label");
  assert.equal(classifyLayoutName("Hangtag AS - License - Wash Care Label"), "CARE_LABEL");
  // A name without separators still gets a chance.
  assert.equal(classifyLayoutName("Banderole"), "BANDEROLE");
});

test("a layout name is one document even when it lists parts", () => {
  // Compound splitting is deliberately NOT applied to layouts.
  assert.equal(
    classifyLayoutName("Coop Norge - License - Carton Marking (Front + Side Label)"),
    "CARTON_MARKING",
  );
});

test("ambiguity is flagged but classification stays total", () => {
  // "Topcard w. hook" hits both TOPCARD and HOOK; the more specific rule is
  // first, so it wins, and the label is flagged for confirmation.
  const r = classifyTrimLabel("Topcard w. hook");
  assert.deepEqual(r.concepts, ["TOPCARD"]);
  assert.equal(r.ambiguous, true);
  // An unambiguous label is not flagged.
  assert.equal(classifyTrimLabel("Hangtag").ambiguous, false);
});

test("unknown vocabulary resolves to nothing rather than to a wrong guess", () => {
  assert.deepEqual(classifyTrimLabel("Jack Bay Trim").concepts, []);
  assert.deepEqual(classifyTrimLabel("as PO00000").concepts, []);
});

test("a Trims cell splits and de-dupes, keeping the printed spelling", () => {
  assert.deepEqual(
    splitTrimsCell("Main label with size, Hangtag, Barcode sticker"),
    ["Main label with size", "Hangtag", "Barcode sticker"],
  );
  // Case variants are the same trim; the first spelling is what prints.
  assert.deepEqual(splitTrimsCell("Carton Marking, carton marking"), ["Carton Marking"]);
  assert.deepEqual(splitTrimsCell(""), []);
});

test("an empty keyword can never match everything", () => {
  const rules = [{ concept: "X", keywords: ["", "  "] }, ...DEFAULT_TRIM_RULES];
  assert.deepEqual(classifyTrimLabel("Hangtag", rules).concepts, ["HANGTAG"]);
});
