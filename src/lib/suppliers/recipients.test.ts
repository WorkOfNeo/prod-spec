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

// The failures seen in production: a single field packing several addresses
// joined by " - " (space-dash-space), which Resend rejects as one bad address.
test("splits a field packing addresses with ' - ' (the real prod failure)", () => {
  const r = combineSupplierRecipients(
    { email: "assistant01@dofinetex.com - assistant03@dofinetex.com", contactEmail: null },
    ["kevin@dofinetex.com", "vivian@dofinetex.com"],
  );
  assert.equal(r.to, "assistant01@dofinetex.com");
  assert.deepEqual(r.cc, ["assistant03@dofinetex.com", "kevin@dofinetex.com", "vivian@dofinetex.com"]);
});

test("splits packed contact fields on comma, semicolon, dash, and newline", () => {
  const r = combineSupplierRecipients(
    { email: null, contactEmail: null },
    ["a@x.com, b@x.com; c@x.com", "d@x.com  - e@x.com\nf@x.com"],
  );
  assert.equal(r.to, "a@x.com");
  assert.deepEqual(r.cc, ["b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"]);
});

test("drops malformed tokens but keeps the valid ones in the same field", () => {
  const r = combineSupplierRecipients(
    { email: "not-an-email - good@x.com", contactEmail: "also bad" },
    ["@nope.com", "fine@x.com"],
  );
  assert.equal(r.to, "good@x.com");
  assert.deepEqual(r.cc, ["fine@x.com"]);
});

test("never splits a hyphen inside a real address", () => {
  const r = combineSupplierRecipients({ email: "first-last@sub-domain.co.uk", contactEmail: null }, []);
  assert.equal(r.to, "first-last@sub-domain.co.uk");
  assert.deepEqual(r.cc, []);
});

test("extracts the address from a 'Name <email>' token", () => {
  const r = combineSupplierRecipients({ email: "Kevin Ng <kevin@dofinetex.com>", contactEmail: null }, []);
  assert.equal(r.to, "kevin@dofinetex.com");
  assert.deepEqual(r.cc, []);
});

test("all sources malformed → null To (surfaces as NO_EMAIL, not a failed send)", () => {
  const r = combineSupplierRecipients({ email: "garbage - also garbage", contactEmail: "nope" }, ["@bad"]);
  assert.deepEqual(r, { to: null, cc: [] });
});
