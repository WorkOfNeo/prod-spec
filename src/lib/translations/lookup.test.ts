import { test } from "node:test";
import assert from "node:assert/strict";
import { translateComposition, type TranslationDictionary } from "./lookup";

// Build a dictionary keyed by normalised English (trim / collapse-spaces /
// lowercase), mirroring how the Monday sync writes Translation.key. Values
// are the Danish column so the assertions read clearly.
function dict(entries: Record<string, string>): TranslationDictionary {
  const map: TranslationDictionary = new Map();
  for (const [english, da] of Object.entries(entries)) {
    const key = english.trim().replace(/\s+/g, " ").toLowerCase();
    map.set(key, { sourceText: english, translations: { da } });
  }
  return map;
}

const DA = dict({
  Top: "Overdel",
  Skirt: "Nederdel",
  Shell: "Yderstof",
  Lining: "For",
  Cotton: "Bomuld",
  Polyester: "Polyester",
  Elastane: "Elastan",
  "Organic Cotton": "Økologisk Bomuld",
});

// ---- multi-part compositions (the new behaviour) --------------------------

test("multi-part: part labels + fibres translate, %/spacing preserved", () => {
  assert.deepEqual(
    translateComposition(DA, "Top: 100% Cotton Skirt: 100% Polyester", "da"),
    { text: "Overdel: 100% Bomuld Nederdel: 100% Polyester", changed: true },
  );
});

test("multi-part: multi-word fibre and a two-fibre section", () => {
  assert.equal(
    translateComposition(DA, "Top: 100% Organic Cotton Skirt: 95% Polyester 5% Elastane", "da").text,
    "Overdel: 100% Økologisk Bomuld Nederdel: 95% Polyester 5% Elastan",
  );
});

test("multi-part: comma between parts is kept", () => {
  assert.equal(
    translateComposition(DA, "Shell: 100% Polyester, Lining: 100% Cotton", "da").text,
    "Yderstof: 100% Polyester, For: 100% Bomuld",
  );
});

test("a bare label with no percentage translates whole", () => {
  assert.deepEqual(translateComposition(DA, "Top", "da"), { text: "Overdel", changed: true });
});

// ---- single-part compositions (regression guards) -------------------------

test("regression: single-part comma composition", () => {
  assert.deepEqual(
    translateComposition(DA, "95% Cotton, 5% Elastane", "da"),
    { text: "95% Bomuld, 5% Elastan", changed: true },
  );
});

test("regression: single-part multi-word fibre", () => {
  assert.equal(translateComposition(DA, "100% Organic Cotton", "da").text, "100% Økologisk Bomuld");
});

test("regression: no-comma multi-fibre", () => {
  assert.equal(
    translateComposition(DA, "92% Polyester 8% Elastane", "da").text,
    "92% Polyester 8% Elastan",
  );
});

// ---- graceful degradation -------------------------------------------------

test("unknown terms degrade to English verbatim, changed=false", () => {
  const empty: TranslationDictionary = new Map();
  assert.deepEqual(
    translateComposition(empty, "Top: 100% Cotton Skirt: 100% Polyester", "da"),
    { text: "Top: 100% Cotton Skirt: 100% Polyester", changed: false },
  );
});

test("partially-known composition keeps the unknown label/fibre in English", () => {
  const partial = dict({ Top: "Overdel", Cotton: "Bomuld" }); // no Skirt, no Polyester
  assert.deepEqual(
    translateComposition(partial, "Top: 100% Cotton Skirt: 100% Polyester", "da"),
    { text: "Overdel: 100% Bomuld Skirt: 100% Polyester", changed: true },
  );
});
