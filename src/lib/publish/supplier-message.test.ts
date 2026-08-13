import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSupplierMessage, applySupplierName } from "./supplier-message";

const base = { supplierName: "Acme Textiles", subject: "About last night's email", body: "Sorry." };

test("greets the supplier and carries the body verbatim", () => {
  const msg = buildSupplierMessage({ ...base, body: "Please ignore the previous email." });
  assert.match(msg.html, /Hi Acme Textiles/);
  assert.match(msg.html, /Please ignore the previous email\./);
  assert.match(msg.text, /Please ignore the previous email\./);
});

test("{{supplier}} is substituted in both subject and body", () => {
  const msg = buildSupplierMessage({
    supplierName: "Acme Textiles",
    subject: "A correction for {{supplier}}",
    body: "Dear {{supplier}} — please disregard.",
  });
  assert.equal(msg.subject, "A correction for Acme Textiles");
  assert.match(msg.html, /Dear Acme Textiles/);
  assert.doesNotMatch(msg.html, /\{\{supplier\}\}/);
  assert.equal(applySupplierName("{{supplier}} & {{supplier}}", "X"), "X & X");
});

test("blank lines become paragraphs, single newlines become breaks", () => {
  const msg = buildSupplierMessage({ ...base, body: "First para.\n\nSecond line one\nline two" });
  assert.equal(msg.html.match(/<p style="margin:0 0 12px;font-size:14px;line-height/g)?.length, 2);
  assert.match(msg.html, /Second line one<br>line two/);
});

test("HTML in the typed body is escaped, not rendered", () => {
  // An admin pasting a supplier name with an ampersand, or typing an angle
  // bracket, must not be able to emit markup into the email.
  const msg = buildSupplierMessage({ ...base, body: '<script>alert("x")</script> Tom & Jerry' });
  assert.doesNotMatch(msg.html, /<script>/);
  assert.match(msg.html, /&lt;script&gt;/);
  assert.match(msg.html, /Tom &amp; Jerry/);
});

test("the subject is escaped in the header but returned raw for the envelope", () => {
  const msg = buildSupplierMessage({ ...base, subject: "Fix <urgent> & fast" });
  assert.equal(msg.subject, "Fix <urgent> & fast");
  assert.match(msg.html, /Fix &lt;urgent&gt; &amp; fast/);
});
