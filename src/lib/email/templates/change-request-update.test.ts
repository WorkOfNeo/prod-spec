import { test } from "node:test";
import assert from "node:assert/strict";
import { changeRequestUpdateEmail } from "./change-request-update";

const base = {
  ref: "R-0007",
  title: "Polybag sticker · PO-0000",
  requestUrl: "https://prodspec.example.com/requests/bogus-id",
};

test("received: confirms, lists the outputs, links the request, promises nothing prints yet", () => {
  const e = changeRequestUpdateEmail({ ...base, kind: "received", outputLabels: ["Polybag sticker", "Care label"], poNumber: "PO-0000" });
  assert.equal(e.subject, "[Prod Spec] R-0007 received — Polybag sticker · PO-0000");
  assert.match(e.html, /href="https:\/\/prodspec\.example\.com\/requests\/bogus-id"/);
  assert.match(e.text, /Outputs: Polybag sticker, Care label/);
  assert.match(e.text, /Nothing changes on a print file until an admin approves it\./);
});

test("needs_info and rejected quote the question or reason", () => {
  const q = changeRequestUpdateEmail({ ...base, kind: "needs_info", outputLabel: "Care label", message: "Which size?" });
  assert.equal(q.subject, "[Prod Spec] R-0007 — a question about your request — Care label");
  assert.match(q.html, /<blockquote[^>]*>Which size\?<\/blockquote>/);
  assert.match(q.text, /Before we can change Care label, we need an answer:\n\nWhich size\?/);

  const r = changeRequestUpdateEmail({ ...base, kind: "rejected", outputLabel: "Care label", message: "Not possible on this stock." });
  assert.equal(r.subject, "[Prod Spec] R-0007 was not changed — Care label");
  assert.match(r.text, /Not possible on this stock\./);
});

test("live mentions the attached proofs only when there are some", () => {
  const withProofs = changeRequestUpdateEmail({ ...base, kind: "live", outputLabel: "Care label", hasProofs: true });
  assert.match(withProofs.text, /Before and after are attached\./);
  assert.match(withProofs.text, /normal review before they reach a supplier/);
  const without = changeRequestUpdateEmail({ ...base, kind: "live" });
  assert.doesNotMatch(without.text, /attached/);
  assert.match(without.text, /The change to the output was approved/);
});

test("user text is escaped in the HTML and left raw in the text body", () => {
  const e = changeRequestUpdateEmail({
    ...base,
    kind: "needs_info",
    title: "<b>title</b>",
    outputLabel: "Tag & <label>",
    message: "<script>x</script>",
  });
  assert.doesNotMatch(e.html, /<script>|<label>|<b>title/);
  assert.match(e.html, /Tag &amp; &lt;label&gt;/);
  assert.match(e.text, /Before we can change Tag & <label>,/);
});
