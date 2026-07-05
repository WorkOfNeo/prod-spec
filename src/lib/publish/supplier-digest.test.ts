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

  assert.match(digest.html, /SharePoint folder: <a href="https:\/\/contoso\.sharepoint\.com\/f\/21069"/);
  assert.match(digest.text, /SharePoint folder: https:\/\/contoso\.sharepoint\.com\/f\/21069/);
  // The portal must NOT appear when the folder link exists — one clear way in.
  assert.doesNotMatch(digest.html, /Portal:/);
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

  assert.match(digest.html, /Portal: <a href="https:\/\/spec\.example\.com\/s\/tok"/);
  assert.match(digest.html, /PIN 1234/);
  assert.doesNotMatch(digest.html, /SharePoint folder:/);
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

  assert.doesNotMatch(digest.html, /SharePoint folder:|Portal:/);
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
