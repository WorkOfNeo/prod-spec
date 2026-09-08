import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// =====================================================
// WHO IS ALLOWED TO IGNORE THE MASTER SWITCH.
//
// `trimsOnCoverEnabled` is off in production, and while it is off a cover must
// render exactly as it always has. `forceTrims: true` is the one way round
// that, and it exists for a good reason: deciding whether to turn the switch on
// requires seeing what turning it on would produce, so the previews have to
// ignore it.
//
// THE PROPERTY THAT MAKES THAT SAFE IS NOT THE BYPASS, IT IS THE CALLER. Every
// caller below computes something and hands it straight back to whoever asked:
// no JobAsset written, no cover fingerprint stamped, no SharePoint push, no
// queue row, no supplier email. Move the bypass into a caller that PERSISTS —
// the refresh sweep, the runner, the publish path, a regenerate endpoint — and
// the switch stops meaning anything: covers would start carrying the trim layer
// with nobody having decided they should, and each one would be overwritten in
// a supplier's folder.
//
// That is not a property any unit test can see, because it is about which file
// the call sits in. So this test reads the source. A new bypass fails here with
// this comment attached, which is the point: adding one is a decision to be
// argued, not a line to be slipped in.
//
// TO ADD A CALLER: satisfy yourself it writes NOTHING — no db mutation, no
// Graph call, no enqueue — then add it here with a note saying so.
// =====================================================

const ALLOWED = new Map<string, string>([
  [
    "src/app/api/admin/settings/cover-page/sample-pdf/route.ts",
    // Renders one cover with puppeteer and returns the bytes as the response.
    // Reads the style, the newest job and the approved base keys; writes none
    // of them back.
    "renders a sample PDF straight into the HTTP response",
  ],
  [
    "src/lib/pdf/cover-manifest-diff.ts",
    // Builds the manifest twice (gated off, then forced) so the preview panel
    // can show before/after as DATA. Never renders and never stores either.
    "builds a before/after manifest for the preview panel",
  ],
  [
    "scripts/cover-manifest-fingerprints.ts",
    // The control run for the no-op check: proves the sample is sensitive to
    // the trim layer, so a matching gated run is evidence rather than a
    // tautology. Documented read-only, and prints to stdout.
    "read-only fingerprint script, prints to stdout",
  ],
]);

// The literal, not the identifier: a file may name `forceTrims` in a comment or
// take it as a parameter (style-cover.ts, required-packaging.ts) without being
// a caller. Setting it true is the act this test is about.
const BYPASS = "forceTrims: true";

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      sourceFiles(rel, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      acc.push(rel);
    }
  }
  return acc;
}

test("only callers that persist nothing may force the trims layer on", () => {
  const found = sourceFiles("src")
    .concat(sourceFiles("scripts"))
    .filter((f) => readFileSync(join(process.cwd(), f), "utf8").includes(BYPASS))
    .sort();

  assert.deepEqual(
    found,
    [...ALLOWED.keys()].sort(),
    `A file started (or stopped) forcing the trims layer on.\n` +
      `If it is new: confirm it writes NOTHING — no JobAsset, no fingerprint, no\n` +
      `SharePoint push, no queue row, no email — and then add it to ALLOWED with\n` +
      `a note saying so. If it persists anything, it must read the switch instead.`,
  );

  // Not vacuous: the allowlist has to name files that exist and still do it.
  assert.equal(found.length, ALLOWED.size);
});
