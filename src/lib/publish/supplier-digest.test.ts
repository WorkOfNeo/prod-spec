import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSupplierDigest, type DigestQueueItem } from "./supplier-digest";

// The digest's per-style link rule (WS3): the supplier's own SharePoint folder
// is the primary link — files are uploaded there before the email leaves — and
// the portal + PIN is the fallback for styles whose folder push hasn't
// succeeded yet. These tests pin that priority so a refactor can't silently
// swap the supplier back to portal-only.

const item = (over: Partial<DigestQueueItem> = {}): DigestQueueItem => ({
  id: "q1",
  styleId: "s1",
  variantKey: "care-label-02",
  docType: "CARE_LABEL",
  displayName: "Care label",
  customerId: "c1",
  supplierId: "sup1",
  ...over,
});

const base = {
  supplierName: "Acme Textiles",
  customerById: new Map([["c1", { name: "Kaufland" }]]),
  baseUrl: "https://spec.example.com",
};

test("links the SharePoint folder when the style has one", () => {
  const digest = buildSupplierDigest({
    ...base,
    items: [item()],
    styleById: new Map([
      [
        "s1",
        {
          name: "21069",
          poNumber: "C-PO63200",
          businessArea: null,
          businessAreaRefName: "Private Label",
          supplierFolderUrl: "https://contoso.sharepoint.com/f/21069",
        },
      ],
    ]),
    shareByStyle: new Map([["s1", { token: "tok", pin: "1234" }]]),
  });

  // The SharePoint folder is the CTA button's target (both HTML and text).
  assert.match(digest.html, /href="https:\/\/contoso\.sharepoint\.com\/f\/21069"[^>]*>Open SharePoint folder/);
  assert.match(digest.text, /SharePoint folder: https:\/\/contoso\.sharepoint\.com\/f\/21069/);
  // The portal must NOT appear when the folder link exists — one clear way in.
  assert.doesNotMatch(digest.html, /Open portal/);
  assert.doesNotMatch(digest.text, /PIN/);
});

test("falls back to portal + PIN when no folder push has succeeded", () => {
  const digest = buildSupplierDigest({
    ...base,
    items: [item()],
    styleById: new Map([
      ["s1", { name: "21069", poNumber: null, businessArea: null, businessAreaRefName: null, supplierFolderUrl: null }],
    ]),
    shareByStyle: new Map([["s1", { token: "tok", pin: "1234" }]]),
  });

  assert.match(digest.html, /href="https:\/\/spec\.example\.com\/s\/tok"[^>]*>Open portal/);
  assert.match(digest.html, /PIN <strong[^>]*>1234<\/strong>/);
  assert.doesNotMatch(digest.html, /Open SharePoint folder/);
});

test("renders no link line when neither folder nor share exists", () => {
  const digest = buildSupplierDigest({
    ...base,
    items: [item()],
    styleById: new Map([
      ["s1", { name: "21069", poNumber: null, businessArea: null, businessAreaRefName: null }],
    ]),
    shareByStyle: new Map(),
  });

  assert.doesNotMatch(digest.html, /Open SharePoint folder|Open portal/);
  assert.doesNotMatch(digest.text, /SharePoint folder:|Portal:/);
});

test("subject counts styles and names customers", () => {
  const digest = buildSupplierDigest({
    ...base,
    items: [item(), item({ id: "q2", styleId: "s2", variantKey: "carton-marking" })],
    styleById: new Map([
      ["s1", { name: "21069", poNumber: null, businessArea: null, businessAreaRefName: null }],
      ["s2", { name: "21070", poNumber: null, businessArea: null, businessAreaRefName: null }],
    ]),
    shareByStyle: new Map(),
  });

  assert.equal(digest.subject, "Approved production specs — 2 styles ready (Kaufland)");
});

test("escapes HTML-special characters in interpolated values", () => {
  const digest = buildSupplierDigest({
    ...base,
    supplierName: "Tom & Jerry <Ltd>",
    items: [item({ displayName: "Care label <A&B>" })],
    styleById: new Map([
      ["s1", { name: "R&D <tee>", poNumber: null, businessArea: "Men & Women", businessAreaRefName: null }],
    ]),
    shareByStyle: new Map(),
  });

  // Raw angle brackets / ampersands must never reach the HTML unescaped.
  assert.doesNotMatch(digest.html, /Tom & Jerry <Ltd>/);
  assert.doesNotMatch(digest.html, /R&D <tee>/);
  assert.match(digest.html, /Tom &amp; Jerry &lt;Ltd&gt;/);
  assert.match(digest.html, /R&amp;D &lt;tee&gt;/);
  assert.match(digest.html, /Care label &lt;A&amp;B&gt;/);
  // Plain-text arm stays raw (no escaping needed there).
  assert.match(digest.text, /R&D <tee>/);
});
