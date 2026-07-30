import { test } from "node:test";
import assert from "node:assert/strict";
import { rejoinWashTokens, type WashcareSymbolMap, type ResolvedSymbol } from "./washcare-symbols";

function fakeSymbol(code: string, mondayValue: string): ResolvedSymbol {
  return { code, name: mondayValue, dataUrl: null, mondayValue, action: null, restrictive: false };
}

function fakeMap(entries: Array<[string, string]>): WashcareSymbolMap {
  const map: WashcareSymbolMap = new Map();
  for (const [code, mondayValue] of entries) {
    const resolved = fakeSymbol(code, mondayValue);
    map.set(code, resolved);
    map.set(mondayValue, resolved);
  }
  return map;
}

test("rejoinWashTokens prefers the longer, more specific compound over a resolvable prefix", () => {
  // Real bug, seen on live styles: the naive comma split shears "Any Solvent
  // except Trichloroethylene, Delicate" into two fragments; the first
  // fragment alone already resolves to the generic symbol, which used to
  // short-circuit the merge search before it ever tried the full compound.
  const map = fakeMap([
    ["dryclean_no_trichloroethylene", "Any Solvent except Trichloroethylene"],
    ["dryclean_no_trichloroethylene_delicate", "Any Solvent except Trichloroethylene, Delicate"],
  ]);
  const tokens = ["Any Solvent except Trichloroethylene", "Delicate"];
  assert.deepEqual(rejoinWashTokens(tokens, map), ["Any Solvent except Trichloroethylene, Delicate"]);
});

test("rejoinWashTokens still resolves independent bare tokens when no longer span matches", () => {
  const map = fakeMap([
    ["wash40", "Wash at or below 40℃"],
    ["bleach_no", "Do Not Bleach"],
  ]);
  const tokens = ["Wash at or below 40℃", "Do Not Bleach"];
  assert.deepEqual(rejoinWashTokens(tokens, map), ["Wash at or below 40℃", "Do Not Bleach"]);
});

test("rejoinWashTokens passes through tokens that never resolve, even joined", () => {
  const map = fakeMap([["wash40", "Wash at or below 40℃"]]);
  const tokens = ["Wash at or below 40℃ - Delicate", "Do Not Bleach"];
  assert.deepEqual(rejoinWashTokens(tokens, map), ["Wash at or below 40℃ - Delicate", "Do Not Bleach"]);
});
