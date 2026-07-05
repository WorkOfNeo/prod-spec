import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScrapePanel, type PoSection } from "./scrape-panel";

// Real C-PO63315 scrape sections (PTQ60031 is the style being resolved).
const SECTIONS: PoSection[] = [
  {
    styleNumber: "PTQ60032",
    contrastNo: "C-33418",
    selected: false,
    variants: [{ label: "PI-86/92 Pink, 86/92", ean13: "5706323598907", used: false }],
    cartonEan: "5706323598945",
  },
  {
    styleNumber: "PTQ60031",
    contrastNo: "C-33423",
    selected: true,
    variants: [
      { label: ".B-86/92 Blue, 86/92", ean13: "5706323599140", used: true },
      { label: ".B-98/104 Blue, 98/104", ean13: "5706323599140", used: true },
    ],
    cartonEan: "5706323599188",
  },
  {
    styleNumber: "PTQ10046",
    contrastNo: "C-33426",
    selected: false,
    variants: [{ label: ".B-86/92 Blue, 86/92", ean13: "5706323599294", used: false }],
    cartonEan: "5706323599331",
  },
];

test("ScrapePanel — highlights the matched section, its per-size EANs + carton", () => {
  const html = renderToStaticMarkup(createElement(ScrapePanel, { sections: SECTIONS }));
  assert.match(html, /3 sections found/);
  assert.match(html, /green = used/);
  // Matched section: its style number, per-size EAN, carton, and the
  // resolved-field tag all render, with the green (emerald) treatment.
  assert.match(html, /PTQ60031/);
  assert.match(html, /5706323599140/);
  assert.match(html, /5706323599188/);
  assert.match(html, /EAN-13 \(per size\)/);
  assert.match(html, /emerald/);
  assert.match(html, /verification only/);
  // A non-selected section is listed compactly (style number + size count +
  // one sample EAN), not expanded into per-size rows that could masquerade as
  // resolved barcodes for this style.
  assert.match(html, /PTQ10046/);
  assert.match(html, /1 size ·/);
});

test("ScrapePanel — colour-scoped section dims the other colourway's rows", () => {
  // Real C-PO63293 shape: ONE section, two colourways, style is "*A" — the
  // B rows stay visible for auditing but are flagged as not used.
  const scoped: PoSection[] = [
    {
      styleNumber: "IL36494",
      contrastNo: "C-33396",
      selected: true,
      variants: [
        { label: "A-M Colour A black/white, M", ean13: "5706323597832", used: true },
        { label: "B-M Colour B navy/white, M", ean13: "5706323597870", used: false },
      ],
      cartonEan: "5706323597917",
    },
  ];
  const html = renderToStaticMarkup(createElement(ScrapePanel, { sections: scoped }));
  assert.match(html, /5706323597832/);
  assert.match(html, /other colourway — not used/);
  // The excluded row's EAN is still shown (audit), just not styled as used.
  assert.match(html, /5706323597870/);
});

test("ScrapePanel — reject case: none matched, nothing stored", () => {
  const none = SECTIONS.map((s) => ({ ...s, selected: false }));
  const html = renderToStaticMarkup(createElement(ScrapePanel, { sections: none }));
  assert.match(html, /none matched this style/);
  assert.match(html, /no per-size EANs were stored/);
  // With no selected section there is no resolved-field tag at all.
  assert.doesNotMatch(html, /EAN-13 \(per size\)/);
});
