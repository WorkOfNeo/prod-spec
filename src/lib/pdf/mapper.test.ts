import { test, before } from "node:test";
import assert from "node:assert/strict";
import { parsePrice } from "./mapper";

// See condition-contains.test.ts — tokens.ts transitively constructs the db
// client at import time, so a dummy DATABASE_URL lets it load (nothing here
// queries). Needed for the end-to-end "what actually prints" test below.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("../output-layouts/tokens").resolveTextToken;
let buildSampleStyleData: typeof import("./sample-data").buildSampleStyleData;

before(async () => {
  ({ resolveTextToken } = await import("../output-layouts/tokens"));
  ({ buildSampleStyleData } = await import("./sample-data"));
});

// ---------------------------------------------------------------------
// Monday's "Retail Prices" column (retail_prices__1) is free text, and
// buyers write the currency on whichever side they please. The original
// regex only accepted a bare number or a TRAILING ISO code, so every
// prefixed value fell through to undefined and {{price}} rendered as an
// empty string — silently, because an unresolved price is not counted as
// a placeholder. Measured against production on 2026-08-13: 135 of the
// 843 priced styles failed to parse, across five customers, and the Coop
// DK barcode tag (line "{{price}} KR") printed a bare "KR".
//
// Every raw value asserted below is one that actually appears in the
// production column.
// ---------------------------------------------------------------------

const amount = (raw: string) => parsePrice(raw)?.amount;

test("the shapes that already worked keep working", () => {
  assert.equal(amount("129.95"), 129.95);
  assert.equal(amount("39,00"), 39);
  assert.equal(amount("29"), 29);
  assert.equal(amount("6.99"), 6.99);
});

test("a leading currency word is stripped — the Coop and REMA shapes", () => {
  assert.equal(amount("KR 69,95"), 69.95);
  assert.equal(amount("KR 149,95"), 149.95);
  assert.equal(amount("Kr. 39,00"), 39);
  assert.equal(amount("kr 79,95"), 79.95);
  assert.equal(amount("SEK 99"), 99);
  assert.equal(amount("€ 12,99"), 12.99);
});

test("a trailing currency word is stripped too", () => {
  assert.equal(amount("129.95 DKK"), 129.95);
  assert.equal(amount("69,95 kr"), 69.95);
  assert.equal(amount("99 SEK"), 99);
});

test("the currency word is dropped, never lifted onto the price", () => {
  // Layouts print their own currency text — the Coop DR barcode tag's line
  // is "{{price}} KR" — so echoing it back would render "69.95 DKK KR".
  // "KR" is also ambiguous across DKK/NOK/SEK.
  assert.deepEqual(parsePrice("KR 69,95"), { amount: 69.95 });
  assert.deepEqual(parsePrice("129.95 DKK"), { amount: 129.95 });
  assert.equal(parsePrice("KR 69,95")?.currency, undefined);
});

test("a label prefix ending in a colon is dropped — Coop's PER SÆT shape", () => {
  // The layout already prints the label itself, via
  //   {{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}
  // so only the number is missing.
  assert.equal(amount("PER SÆT:KR 129,95"), 129.95);
  assert.equal(amount("PER SÆT:KR 229,95"), 229.95);
});

test('"See customer order" stays empty — it is not a price', () => {
  // 100 live styles across Woolworth, KiK and Dollarstore.
  assert.equal(parsePrice("See customer order"), undefined);
  assert.equal(parsePrice("see customer order"), undefined);
});

test("two amounts for two markets print nothing rather than the wrong one", () => {
  // Dollarstore, 7 live styles. Picking either number puts the other
  // market's price on a physical label.
  assert.equal(parsePrice("99 SEK, 69 DKK"), undefined);
  assert.equal(parsePrice("79 SEK, 59 DKK"), undefined);
});

test("junk and empties stay undefined", () => {
  assert.equal(parsePrice(""), undefined);
  assert.equal(parsePrice("   "), undefined);
  assert.equal(parsePrice("TBC"), undefined);
  assert.equal(parsePrice("ask buyer"), undefined);
  assert.equal(parsePrice("KR"), undefined);
  assert.equal(parsePrice("129."), undefined);
  assert.equal(parsePrice("1,2,3"), undefined);
});

// ---------------------------------------------------------------------
// End to end: the raw Monday value → parsePrice → what {{price}} prints.
// This is the loop the live bug ran through — style MG10024's "KR 69,95"
// reached the Coop DK barcode tag, whose line is "{{price}} KR", and the
// production render came out as a bare "KR".
// ---------------------------------------------------------------------

const printed = (raw: string) =>
  resolveTextToken({ ...buildSampleStyleData(), price: parsePrice(raw) }, "price");

test("{{price}} prints the number for a currency-prefixed value", () => {
  assert.equal(printed("KR 69,95"), "69,95");
  assert.equal(printed("Kr. 39,00"), "39,00");
  assert.equal(printed("PER SÆT:KR 129,95"), "129,95");
});

test("{{price}} prints comma decimals, matching the spec-generic renderer", () => {
  // The layout writes its own currency ("{{price}} KR"), so the token must
  // not echo one back — the tag reads "69,95 KR", not "69.95 DKK KR".
  assert.equal(printed("KR 69,95"), "69,95");
  assert.equal(printed("129.95"), "129,95");
  assert.equal(printed("29"), "29,00");
});

test("{{price}} stays empty for the values that are not prices", () => {
  assert.equal(printed("See customer order"), "");
  assert.equal(printed("99 SEK, 69 DKK"), "");
  assert.equal(printed(""), "");
});

test("the separator's meaning is decided by what follows it", () => {
  // Two decimals → decimal separator, either character.
  assert.equal(amount("119,95"), 119.95);
  assert.equal(amount("119.95"), 119.95);
  // Three digits → thousands group. The old parse did a single
  // .replace(",", ".") and read "1.299" as 1.299 — a 1000x error waiting
  // for the first four-figure price.
  assert.equal(amount("1.299"), 1299);
  assert.equal(amount("1,299"), 1299);
  assert.equal(amount("1.299,95"), 1299.95);
  assert.equal(amount("1,299.95"), 1299.95);
});
