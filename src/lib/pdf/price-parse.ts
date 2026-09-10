// =====================================================
// Retail-price parsing — the one place that turns Monday's free-text
// "Retail Prices" column into a number.
//
// Deliberately DEPENDENCY-FREE so it can be imported from client-safe
// modules (the generation-rule engine in src/lib/outputs/exclusion.ts
// renders in the rule editors) as well as from the server-side mapper.
// Keep it that way — no db, no Monday client, no type imports that drag
// a runtime module in behind them.
//
// The rule engine and the {{price}} token must agree on what counts as a
// price: a value the mapper refuses to parse prints nothing, so a numeric
// rule has to treat it as "no price" too, not as zero.
// =====================================================

// A currency word that may sit before OR after the amount — Monday's
// "Retail Prices" column is free text and buyers write the currency on
// whichever side they please ("KR 69,95", "Kr. 39,00", "129.95 DKK").
//
// It is matched only to be REMOVED. We deliberately never lift it into
// price.currency:
//   • layouts already print their own currency text — the Coop DR barcode
//     tag's line is literally "{{price}} KR", so echoing it back would
//     render "69.95 DKK KR";
//   • "KR" isn't an ISO code and is ambiguous across DKK/NOK/SEK, so
//     mapping it would mean guessing from the customer;
//   • every value that parses today is a bare number, so no live style
//     loses a currency it used to print.
const CURRENCY_WORD = /(?:kr\.?|dkk|nok|sek|eur|gbp|chf|usd|[€£$])/i;
const LEADING_CURRENCY = new RegExp(`^${CURRENCY_WORD.source}\\s*`, "i");
const TRAILING_CURRENCY = new RegExp(`\\s*${CURRENCY_WORD.source}$`, "i");

// What's left after the currency word is stripped must be ONE number, with
// optional thousands groups and at most two decimals. Anything else — a
// second amount, stray words — is rejected rather than guessed at.
const AMOUNT = /^\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?$/;

// Both "." and "," appear as the decimal separator in live data (and both
// appear as thousands separators elsewhere), so the separator's MEANING is
// decided by what follows it: three trailing digits is a thousands group,
// one or two is the decimal part.
function toAmount(s: string): number | undefined {
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (lastSep === -1) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const after = s.slice(lastSep + 1);
  const [intPart, fracPart] =
    after.length === 3
      ? [s.replace(/[.,]/g, ""), ""] // "1.299" → 1299
      : [s.slice(0, lastSep).replace(/[.,]/g, ""), after]; // "1.299,95" → 1299.95
  const n = Number(fracPart ? `${intPart}.${fracPart}` : intPart);
  return Number.isFinite(n) ? n : undefined;
}

// The numeric value of a retail-price cell, or undefined when the cell
// isn't a single unambiguous amount.
export function parsePriceAmount(raw: string): number | undefined {
  if (!raw) return undefined;
  let s = raw.trim();

  // "PER SÆT:KR 129,95" — Coop buyers prefix the value with the very label
  // the layout already prints for itself ({{if productGroup contains Set}}
  // PER SÆT{{else}}KR.{{endif}}), so drop everything up to the last colon
  // and price what follows.
  const colon = s.lastIndexOf(":");
  if (colon !== -1) s = s.slice(colon + 1).trim();

  s = s.replace(LEADING_CURRENCY, "").replace(TRAILING_CURRENCY, "").trim();

  // Rejected here, on purpose:
  //   "See customer order" — 100 live styles; not a price, must stay empty.
  //   "99 SEK, 69 DKK"     — two amounts for two markets. Stripping the
  //                          trailing DKK leaves "99 SEK, 69", which fails
  //                          AMOUNT, so nothing prints. Picking one would
  //                          put the wrong market's number on a physical
  //                          label, which is worse than printing none.
  if (!AMOUNT.test(s)) return undefined;
  return toAmount(s);
}
