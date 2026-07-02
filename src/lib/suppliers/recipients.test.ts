import { test } from "node:test";
import assert from "node:assert/strict";
import { combineSupplierRecipients } from "./recipients";

// The one resolution rule for supplier emails: To = company inbox → first
// synced contact → legacy contactEmail; everything else lands on CC once.

test("supplier inbox wins To; contacts + legacy contactEmail go on CC", () => {
  const r = combineSupplierRecipients(
    { email: "inbox@supplier.com", contactEmail: "legacy@supplier.com" },
    ["anna@supplier.com", "bo@supplier.com"],
  );
  assert.equal(r.to, "inbox@supplier.com");
  assert.deepEqual(r.cc, ["anna@supplier.com", "bo@supplier.com", "legacy@supplier.com"]);
});

test("no company inbox — first contact becomes To, rest CC", () => {
  const r = combineSupplierRecipients(
    { email: null, contactEmail: null },
    ["anna@supplier.com", "bo@supplier.com"],
  );
  assert.equal(r.to, "anna@supplier.com");
  assert.deepEqual(r.cc, ["bo@supplier.com"]);
});

test("no inbox, no contacts — legacy contactEmail becomes To (old behavior)", () => {
  const r = combineSupplierRecipients({ email: null, contactEmail: "legacy@supplier.com" }, []);
  assert.equal(r.to, "legacy@supplier.com");
  assert.deepEqual(r.cc, []);
});

test("nothing on file — null To, empty CC (caller falls back to env)", () => {
  assert.deepEqual(combineSupplierRecipients({ email: null, contactEmail: null }, []), {
    to: null,
    cc: [],
  });
  assert.deepEqual(combineSupplierRecipients(undefined, []), { to: null, cc: [] });
});

test("dedupes case-insensitively and never CCs the To address", () => {
  const r = combineSupplierRecipients(
    { email: "Anna@Supplier.com", contactEmail: "ANNA@supplier.com" },
    ["anna@supplier.com", "bo@supplier.com", "BO@supplier.com"],
  );
  assert.equal(r.to, "Anna@Supplier.com");
  assert.deepEqual(r.cc, ["bo@supplier.com"]);
});

test("trims whitespace and drops blank entries", () => {
  const r = combineSupplierRecipients(
    { email: "  inbox@supplier.com ", contactEmail: "  " },
    ["  anna@supplier.com ", "", "  "],
  );
  assert.equal(r.to, "inbox@supplier.com");
  assert.deepEqual(r.cc, ["anna@supplier.com"]);
});
