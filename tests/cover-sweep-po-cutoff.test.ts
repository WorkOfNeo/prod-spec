// The cover sweep is a bulk lane, so it obeys the GENERATION PO cutoff — and it
// obeys it the way the other bulk lanes do: default to the in-scope styles, say
// how many were parked, let the operator opt them back in.
//
// Measured when this landed: 1,401 of 1,919 cover-holding styles sat below the
// cutoff, so three quarters of every sweep was rendering covers that
// enqueueCoverForSupplier then refused to push ("below-cutoff"). The risk in
// fixing that is picking the WRONG cutoff. There are two, with deliberately
// opposite NULL rules (src/lib/queue/generation-cutoff.ts): generation counts a
// null poSeq as in scope, supplier-send counts it as undeliverable. Swap them
// here and a style whose PO never parsed quietly stops having its cover
// maintained — invisible, because such a style also never reaches a supplier to
// complain. So the null case is pinned explicitly.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const CUTOFF = 63320;

// Four styles with a current cover: two clear the cutoff, one is an old order,
// one never parsed a PO number.
const JOB_ROWS = [
  { styleId: "sty-new-a", style: { poSeq: 70000 } },
  { styleId: "sty-old", style: { poSeq: 61331 } },
  { styleId: "sty-new-b", style: { poSeq: CUTOFF } }, // exactly at the cutoff — in
  { styleId: "sty-nopo", style: { poSeq: null } },
];

let lastWhere: unknown = null;

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        job: {
          findMany: async (args: { where: unknown }) => {
            lastWhere = args.where;
            return JOB_ROWS;
          },
        },
      },
    },
  });
  mock.module("@/lib/settings/app-settings", {
    namedExports: {
      getGenerationMinPo: async () => CUTOFF,
      // Present so a mistaken switch to the supplier-send cutoff resolves rather
      // than throwing — the test must fail on BEHAVIOUR, not on a missing mock.
      getSupplierSendMinPo: async () => CUTOFF,
    },
  });
});

beforeEach(() => {
  lastWhere = null;
});

test("parks below-cutoff orders by default and reports how many", async () => {
  const { listCoverStyleIdSet } = await import("@/lib/pdf/cover-style-ids");
  const res = await listCoverStyleIdSet();

  assert.ok(!res.styleIds.includes("sty-old"), "an order below the cutoff was swept");
  assert.equal(res.skippedBelowCutoff, 1);
  assert.equal(res.cutoff, CUTOFF);
});

test("a style at exactly the cutoff is IN scope", async () => {
  const { listCoverStyleIdSet } = await import("@/lib/pdf/cover-style-ids");
  const res = await listCoverStyleIdSet();

  assert.ok(res.styleIds.includes("sty-new-b"), "the cutoff must be inclusive (poSeq >= cutoff)");
});

test("a NULL poSeq stays IN scope — the generation rule, not the supplier one", async () => {
  // The whole reason two cutoff predicates exist. Under the supplier-send rule
  // this style would be dropped, and its cover would silently stop being
  // maintained.
  const { listCoverStyleIdSet } = await import("@/lib/pdf/cover-style-ids");
  const res = await listCoverStyleIdSet();

  assert.ok(
    res.styleIds.includes("sty-nopo"),
    "a style with no parseable PO must still have its cover refreshed",
  );
  assert.deepEqual(res.styleIds, ["sty-new-a", "sty-new-b", "sty-nopo"]);
});

test("includeBelowCutoff sweeps the parked orders too", async () => {
  const { listCoverStyleIdSet } = await import("@/lib/pdf/cover-style-ids");
  const res = await listCoverStyleIdSet({ includeBelowCutoff: true });

  assert.equal(res.styleIds.length, 4);
  assert.ok(res.styleIds.includes("sty-old"));
  assert.equal(res.skippedBelowCutoff, 0);
  // Still reported, because the confirm copy names the cutoff on both paths.
  assert.equal(res.cutoff, CUTOFF);
});

test("prodSpecId scopes through the STYLE's current spec, not the job's", async () => {
  // A style re-pointed to another spec since its last job must follow its
  // present-day spec — that is whose General information a refreshed cover
  // prints. Pinned because the scoping is easy to write against the job.
  const { listCoverStyleIdSet } = await import("@/lib/pdf/cover-style-ids");
  await listCoverStyleIdSet({ prodSpecId: "spec-1" });

  assert.deepEqual(
    (lastWhere as { style?: unknown }).style,
    { prodSpecId: "spec-1" },
    "scope must be applied through the style relation",
  );
});
