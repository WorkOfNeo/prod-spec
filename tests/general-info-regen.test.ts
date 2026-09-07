// Role gate + blast radius for
// /api/admin/prod-specs/[id]/general-info/regenerate — the "regenerate these
// covers and re-upload them" escape hatch beside the General information editor.
//
// Five things are under test, and the last three are the ones that matter:
//
//   1. The gate: ADMIN and REVIEWER pass, another signed-in role is 403'd
//      before any DB work, no session is 401'd. Matches the sibling
//      general-info route — reviewers own this prose.
//   2. Resolution: a style number is NOT unique in this data (one Pre-Order row
//      per PO, two colourways per number), so several matches must come back as
//      a list, never silently narrowed to one.
//   3. ACTING ON THE WHOLE LIST. Several matches is the ordinary case, so `run`
//      works through every style it was given. Independently: one style's
//      render throwing must not cost the others their fix, and — the sharper
//      half — a run where one of five failed must not come back reading as one
//      success. The per-style results and the counted summary are the contract.
//   4. EACH STYLE AGAINST ITS OWN SPEC. `run` no longer refuses a style
//      belonging to a different prod spec (it used to 409). The correctness
//      that refusal was protecting is still enforced, structurally: a cover
//      renders its OWN spec's General information, so the tests below drive a
//      foreign style through the route and assert it rendered the other spec's
//      text — and that this route never so much as loads the open spec's prose.
//   5. NO ProdSpec WRITE. The full /api/admin/prod-specs/<id> PATCH
//      auto-activates a draft spec on any content change (its `hasOtherChange`
//      counts generalInfoMd) — which is what makes a spec eligible for job
//      auto-enqueue. This route deliberately never goes through it. The
//      assertions below pin that: db.prodSpec.update is never called, on any
//      path including the multi-style one. If someone later routes this through
//      the generic PATCH, they fail.
//
// Drives the REAL route handler with a mocked session, a spy `db`, and mocked
// render/push chains, so nothing touches the live DB, Chromium or SharePoint.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── Session ─────────────────────────────────────────────────────────────────
let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
const asAdmin = () => {
  sessionState = { session: { user: { id: "admin-1" } }, role: "ADMIN" };
};
const asReviewer = () => {
  sessionState = { session: { user: { id: "rev-1" } }, role: "REVIEWER" };
};
const asViewer = () => {
  sessionState = { session: { user: { id: "v-1" } }, role: "VIEWER" };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// ── Fixtures. No live PO numbers, clients or suppliers. ─────────────────────
const SPEC = { id: "spec-1", name: "Acme · Shoes" };

// The General information each spec holds. buildStyleCoverPdf reads this from
// the STYLE's own prodSpec row, which is what makes a cross-spec regenerate
// correct rather than merely permitted; the refresh spy below models that
// lookup so the route can be held to it.
const GENERAL_INFO: Record<string, string> = {
  "spec-1": "General information for Acme · Shoes",
  "spec-other": "General information for Other · Bags",
};

type StyleRow = {
  id: string;
  name: string;
  status: string;
  poNumber: string | null;
  prodSpecId: string | null;
  supplierFolderUrl?: string | null;
  customer: { name: string } | null;
  supplier: { name: string } | null;
  prodSpec: { name: string } | null;
};

const STYLES: StyleRow[] = [
  {
    id: "st-1",
    name: "AA10001",
    status: "APPROVED",
    poNumber: "PO-A",
    prodSpecId: "spec-1",
    supplierFolderUrl: "https://example.invalid/folder",
    customer: { name: "Acme" },
    supplier: { name: "Supplier One" },
    prodSpec: { name: "Acme · Shoes" },
  },
  {
    // Same style NUMBER, different order — the ordinary ambiguity, and the
    // reason `run` acts on a list rather than on one row.
    id: "st-2",
    name: "AA10001",
    status: "APPROVED",
    poNumber: "PO-B",
    prodSpecId: "spec-1",
    customer: { name: "Acme" },
    supplier: { name: "Supplier One" },
    prodSpec: { name: "Acme · Shoes" },
  },
  {
    // Belongs to a DIFFERENT prod spec. Allowed now — it must regenerate
    // against ITS spec's General information, not the open one's.
    id: "st-9",
    name: "ZZ90009",
    status: "APPROVED",
    poNumber: "PO-Z",
    prodSpecId: "spec-other",
    customer: { name: "Other" },
    supplier: { name: "Supplier Two" },
    prodSpec: { name: "Other · Bags" },
  },
];

// ── Spies ───────────────────────────────────────────────────────────────────
type ProdSpecFindArgs = { where: { id: string }; select: Record<string, boolean> };
const prodSpecFindUnique = mock.fn<(args: ProdSpecFindArgs) => Promise<unknown>>(
  async () => SPEC as unknown,
);
// The canary: this route must NEVER write a ProdSpec column.
const prodSpecUpdate = mock.fn(async () => ({}) as unknown);

// One spy, two shapes: `resolve` searches by name, `run` fetches by id set.
type StyleFindManyArgs = { where: { name?: { contains: string }; id?: { in: string[] } } };
const styleFindMany = mock.fn(async (args: StyleFindManyArgs) => {
  const ids = args.where.id?.in;
  if (ids) return STYLES.filter((s) => ids.includes(s.id)) as unknown;
  const q = (args.where.name?.contains ?? "").toLowerCase();
  return STYLES.filter((s) => s.name.toLowerCase().includes(q)) as unknown;
});
const jobFindMany = mock.fn(async () => [{ styleId: "st-1" }, { styleId: "st-2" }] as unknown);
const queueFindUnique = mock.fn(
  async () =>
    ({
      sharePointStatus: "UPLOADED",
      sharePointFolderUrl: "https://example.invalid/approved-layouts",
      sharePointError: null,
    }) as unknown,
);
const logCreate = mock.fn(async () => ({}));

// Render / delivery chain — mocked so no Chromium and no Graph call. The
// parameter lists are spelled out (rather than inferred from the default
// implementation) so the spies accept every shape the tests re-stub them with,
// and so `arguments[n]` is typed where the assertions read it back.
type RefreshResult =
  | { styleId: string; status: "refreshed"; coverAssetId: string; jobId: string }
  | { styleId: string; status: "no-cover" };
type RefreshOpts = {
  stampManifest?: boolean;
  onlyWhenChanged?: boolean;
  onlyWhenPending?: boolean;
};
type PushOpts = { styleIds?: string[]; recordRunAs?: string };
type PushSweep = {
  styles: number;
  uploaded: number;
  failed: number;
  skipped: number;
  noFolder: number;
  ambiguous: number;
  failures: Array<{ styleId: string; status: string; message: string }>;
};

// What each rebuild PRINTED, recorded the way the real chain resolves it: from
// the style's own prod spec. Read back by the cross-spec tests.
const rendered: Array<{ styleId: string; generalInfo: string | null }> = [];

const refreshStyleCoverAsset = mock.fn<
  (styleId: string, opts?: RefreshOpts) => Promise<RefreshResult>
>(async (styleId) => {
  const style = STYLES.find((s) => s.id === styleId);
  rendered.push({
    styleId,
    generalInfo: style?.prodSpecId ? (GENERAL_INFO[style.prodSpecId] ?? null) : null,
  });
  return { styleId, status: "refreshed", coverAssetId: `asset-${styleId}`, jobId: `job-${styleId}` };
});
const enqueueCoverForSupplier = mock.fn<
  (styleId: string, coverAssetId: string, opts?: { notifySupplier?: boolean }) => Promise<string>
>(async () => "queued");
const pushQueuedSupplierUploads = mock.fn<(opts?: PushOpts) => Promise<PushSweep>>(async () => ({
  styles: 1,
  uploaded: 1,
  failed: 0,
  skipped: 0,
  noFolder: 0,
  ambiguous: 0,
  failures: [],
}));

before(() => {
  // canReview stays real — the gate's actual predicate is what's under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        prodSpec: { findUnique: prodSpecFindUnique, update: prodSpecUpdate },
        style: { findMany: styleFindMany },
        job: { findMany: jobFindMany },
        supplierSendQueueItem: { findUnique: queueFindUnique },
        log: { create: logCreate },
      },
    },
  });
  mock.module("@/lib/pdf/refresh-cover", { namedExports: { refreshStyleCoverAsset } });
  mock.module("@/lib/publish/requeue-cover", { namedExports: { enqueueCoverForSupplier } });
  mock.module("@/lib/sharepoint/push-queued-to-supplier", {
    namedExports: { pushQueuedSupplierUploads },
  });
});

beforeEach(() => {
  for (const m of [
    prodSpecFindUnique,
    prodSpecUpdate,
    styleFindMany,
    jobFindMany,
    queueFindUnique,
    logCreate,
    refreshStyleCoverAsset,
    enqueueCoverForSupplier,
    pushQueuedSupplierUploads,
  ]) {
    // restore() as well as resetCalls(): the multi-style tests below install
    // implementations that must not leak into the next test.
    m.mock.restore();
    m.mock.resetCalls();
  }
  rendered.length = 0;
});

const ctx = { params: Promise.resolve({ id: "spec-1" }) };

async function call(body: unknown) {
  const mod = await import("@/app/api/admin/prod-specs/[id]/general-info/regenerate/route");
  const POST = mod.POST as (
    req: NextRequest,
    c: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  const req = new NextRequest(
    "http://localhost/api/admin/prod-specs/spec-1/general-info/regenerate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const res = await POST(req, ctx);
  let parsed: unknown = null;
  try {
    parsed = await res.clone().json();
  } catch {
    /* empty body */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: parsed as any };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resultFor = (body: any, styleId: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body.results.find((r: any) => r.styleId === styleId);

// ── 1. The gate ─────────────────────────────────────────────────────────────

test("REVIEWER may regenerate", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleIds: ["st-1"] });
  assert.equal(status, 200);
  assert.equal(body.results[0].refreshed, true);
});

test("ADMIN may regenerate", async () => {
  asAdmin();
  const { status } = await call({ mode: "run", styleIds: ["st-1"] });
  assert.equal(status, 200);
});

test("a non-review role is refused with 403 before any DB work", async () => {
  asViewer();
  const { status, body } = await call({ mode: "resolve", styleNumber: "AA10001" });
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/);
  assert.equal(prodSpecFindUnique.mock.callCount(), 0, "gate blocks before touching the DB");
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

test("no session is rejected with 401 and nothing is rendered or pushed", async () => {
  asAnon();
  const { status } = await call({ mode: "run", styleIds: ["st-1"] });
  assert.equal(status, 401);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0);
});

// ── 2. Resolution ───────────────────────────────────────────────────────────

test("two styles sharing a number come back as a list, not a guess", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "resolve", styleNumber: "AA10001" });
  assert.equal(status, 200);
  assert.equal(body.ambiguous, true);
  assert.equal(body.matches.length, 2, "both PO rows are offered");
  assert.deepEqual(
    body.matches.map((m: { poNumber: string }) => m.poNumber).sort(),
    ["PO-A", "PO-B"],
    "the PO is what tells them apart, so it must be on the candidate",
  );
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0, "resolve never acts");
});

test("resolve marks a style from another prod spec rather than hiding it", async () => {
  asReviewer();
  const { body } = await call({ mode: "resolve", styleNumber: "ZZ90009" });
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].inThisSpec, false);
  assert.equal(body.matches[0].prodSpecName, "Other · Bags", "names the spec it belongs to");
});

test("resolve reports hasCover so a never-generated style is not offered as fixable", async () => {
  asReviewer();
  jobFindMany.mock.mockImplementationOnce(async () => [] as unknown);
  const { body } = await call({ mode: "resolve", styleNumber: "AA10001" });
  assert.equal(body.matches[0].hasCover, false);
});

test("an unknown style number resolves to no matches, never to something else", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "resolve", styleNumber: "QQ00000" });
  assert.equal(status, 200);
  assert.deepEqual(body.matches, []);
});

test("an unknown prod spec is 404'd", async () => {
  asReviewer();
  prodSpecFindUnique.mock.mockImplementationOnce(async () => null as unknown);
  const { status } = await call({ mode: "resolve", styleNumber: "AA10001" });
  assert.equal(status, 404);
});

test("a malformed body is 400'd and nothing is rendered", async () => {
  asReviewer();
  const { status } = await call({ mode: "run" });
  assert.equal(status, 400);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

test("an empty style list is 400'd — 'run' must always name what it acts on", async () => {
  asReviewer();
  const { status } = await call({ mode: "run", styleIds: [] });
  assert.equal(status, 400);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

test("more styles than the resolve ceiling is refused, not attempted", async () => {
  asReviewer();
  const tooMany = Array.from({ length: 26 }, (_, i) => `st-${i}`);
  const { status } = await call({ mode: "run", styleIds: tooMany });
  assert.equal(status, 400, "26 Chromium renders in one request is not a thing we start");
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

// ── 3. Acting on the whole list ─────────────────────────────────────────────

test("run acts on EVERY style it was given, not just the first", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleIds: ["st-1", "st-2"] });
  assert.equal(status, 200);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 2, "both covers rebuilt");
  assert.deepEqual(
    refreshStyleCoverAsset.mock.calls.map((c) => c.arguments[0]).sort(),
    ["st-1", "st-2"],
  );
  assert.equal(enqueueCoverForSupplier.mock.callCount(), 2);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 2);
  assert.equal(body.results.length, 2, "one row per style");
  assert.equal(body.summary.total, 2);
  assert.equal(body.summary.pushed, 2);
  assert.equal(body.summary.allSucceeded, true);
});

test("each push is scoped to its own style id — no fan-out across the list", async () => {
  asReviewer();
  await call({ mode: "run", styleIds: ["st-1", "st-2"] });
  assert.deepEqual(
    pushQueuedSupplierUploads.mock.calls.map((c) => c.arguments[0]!.styleIds),
    [["st-1"], ["st-2"]],
    "a push carries exactly the style it belongs to, so a failure has a name",
  );
});

test("one style failing does NOT abandon the rest", async () => {
  asReviewer();
  refreshStyleCoverAsset.mock.mockImplementation(async (styleId: string) => {
    if (styleId === "st-1") throw new Error("chromium died");
    return { styleId, status: "refreshed" as const, coverAssetId: "a", jobId: "j" };
  });
  const { status, body } = await call({ mode: "run", styleIds: ["st-1", "st-2"] });
  assert.equal(status, 200, "the request itself is not a failure");
  assert.equal(resultFor(body, "st-1").outcome, "error");
  assert.match(resultFor(body, "st-1").message, /chromium died/);
  assert.equal(resultFor(body, "st-2").outcome, "pushed", "the second style still got its fix");
});

test("a partial failure NEVER reads as one success", async () => {
  asReviewer();
  pushQueuedSupplierUploads.mock.mockImplementation(async (opts?: PushOpts) => {
    const failed = opts?.styleIds?.[0] === "st-2";
    return {
      styles: 1,
      uploaded: failed ? 0 : 1,
      failed: failed ? 1 : 0,
      skipped: 0,
      noFolder: 0,
      ambiguous: 0,
      failures: failed ? [{ styleId: "st-2", status: "FAILED", message: "write refused" }] : [],
    };
  });
  const { body } = await call({ mode: "run", styleIds: ["st-1", "st-2"] });
  assert.equal(body.summary.allSucceeded, false, "one of two failed, so the run did not succeed");
  assert.equal(body.summary.pushed, 1);
  assert.equal(body.summary.pushFailed, 1);
  assert.equal(resultFor(body, "st-1").outcome, "pushed");
  assert.equal(resultFor(body, "st-2").outcome, "push-failed");
  assert.equal(resultFor(body, "st-2").pushError, "write refused");
});

test("a style with no cover yet is explained per style, not rendered or pushed", async () => {
  asReviewer();
  refreshStyleCoverAsset.mock.mockImplementation(async (styleId: string) =>
    styleId === "st-1"
      ? { styleId, status: "no-cover" as const }
      : { styleId, status: "refreshed" as const, coverAssetId: "a", jobId: "j" },
  );
  const { body } = await call({ mode: "run", styleIds: ["st-1", "st-2"] });
  assert.equal(resultFor(body, "st-1").outcome, "no-cover");
  assert.equal(resultFor(body, "st-1").refreshed, false);
  assert.match(resultFor(body, "st-1").message, /never generated/);
  assert.equal(resultFor(body, "st-2").outcome, "pushed");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 1, "only the one with a cover is pushed");
  assert.equal(body.summary.noCover, 1);
  assert.equal(body.summary.allSucceeded, false, "'nothing to rebuild' is not a delivered fix");
});

test("an id that no longer resolves is reported, and the rest still run", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleIds: ["gone", "st-1"] });
  assert.equal(status, 200);
  assert.equal(resultFor(body, "gone").outcome, "not-found");
  assert.equal(resultFor(body, "st-1").outcome, "pushed");
  assert.equal(body.summary.failed, 1);
});

test("every id unknown is a 404, not a page of empty rows", async () => {
  asReviewer();
  const { status } = await call({ mode: "run", styleIds: ["nope", "also-nope"] });
  assert.equal(status, 404);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

test("the same id twice rebuilds and re-pushes once", async () => {
  asReviewer();
  const { body } = await call({ mode: "run", styleIds: ["st-1", "st-1"] });
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 1);
  assert.equal(body.results.length, 1);
});

// ── 4. Each style against its OWN spec ──────────────────────────────────────

test("run no longer refuses a style belonging to a different prod spec", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleIds: ["st-9"] });
  assert.equal(status, 200, "typing a number from another client's tab is allowed now");
  assert.equal(resultFor(body, "st-9").outcome, "pushed");
  assert.equal(resultFor(body, "st-9").inThisSpec, false, "but the report says it was foreign");
  assert.equal(
    resultFor(body, "st-9").prodSpecName,
    "Other · Bags",
    "and names whose General information it printed",
  );
});

test("a style from another spec regenerates with THAT spec's General information", async () => {
  asReviewer();
  // Open spec is spec-1 throughout (ctx above). st-9 lives under spec-other.
  const { status } = await call({ mode: "run", styleIds: ["st-1", "st-9"] });
  assert.equal(status, 200);
  assert.deepEqual(
    rendered,
    [
      { styleId: "st-1", generalInfo: "General information for Acme · Shoes" },
      { styleId: "st-9", generalInfo: "General information for Other · Bags" },
    ],
    "each cover printed its own spec's prose — the open spec's text never leaked " +
      "into the foreign style's cover, which is the correctness the old 409 protected",
  );
});

test("the render is handed the style id and nothing spec-derived", async () => {
  asReviewer();
  await call({ mode: "run", styleIds: ["st-9"] });
  const call0 = refreshStyleCoverAsset.mock.calls[0]!;
  assert.equal(call0.arguments[0], "st-9");
  assert.deepEqual(
    Object.keys(call0.arguments[1] ?? {}),
    ["stampManifest"],
    "no prod spec id and no prose ride along — the refresh resolves the spec itself",
  );
});

test("the OPEN spec's General information is never even loaded", async () => {
  asReviewer();
  await call({ mode: "run", styleIds: ["st-9"] });
  const select = prodSpecFindUnique.mock.calls[0]!.arguments[0]!.select;
  assert.deepEqual(
    Object.keys(select).sort(),
    ["id", "name"],
    "selecting generalInfoMd here would be the first step towards printing the " +
      "wrong client's text on a foreign style's cover",
  );
});

// ── 5. The draft-activation constraint ──────────────────────────────────────

test("NO ProdSpec column is ever written — the spec cannot be auto-activated", async () => {
  asReviewer();
  await call({ mode: "resolve", styleNumber: "AA10001" });
  await call({ mode: "run", styleIds: ["st-1"] });
  await call({ mode: "run", styleIds: ["st-1", "st-2", "st-9"] });
  await call({ mode: "run", styleIds: ["nope"] });
  assert.equal(
    prodSpecUpdate.mock.callCount(),
    0,
    "routing this through the generic ProdSpec PATCH would flip a draft spec's `active` " +
      "to true (its hasOtherChange counts generalInfoMd) and arm it for job auto-enqueue",
  );
});

// ── Reporting: both halves, independently ───────────────────────────────────

test("a successful run reports the regenerate AND the push, with the folder", async () => {
  asReviewer();
  const { body } = await call({ mode: "run", styleIds: ["st-1"] });
  const r = resultFor(body, "st-1");
  assert.equal(r.refreshed, true);
  assert.equal(r.requeue, "queued");
  assert.equal(r.pushed, 1);
  assert.equal(r.pushFailed, 0);
  assert.equal(r.folderUrl, "https://example.invalid/approved-layouts");
});

test("a push failure is reported as a failure, not as a success", async () => {
  asReviewer();
  pushQueuedSupplierUploads.mock.mockImplementationOnce(async () => ({
    styles: 1,
    uploaded: 0,
    failed: 1,
    skipped: 0,
    noFolder: 0,
    ambiguous: 0,
    failures: [{ styleId: "st-1", status: "FAILED", message: "write refused" }],
  }));
  const { body } = await call({ mode: "run", styleIds: ["st-1"] });
  const r = resultFor(body, "st-1");
  assert.equal(r.refreshed, true, "the rebuild did happen");
  assert.equal(r.pushFailed, 1, "and the push did not — reported separately");
  assert.equal(r.outcome, "push-failed");
  assert.equal(r.pushError, "write refused");
  assert.equal(body.summary.allSucceeded, false);
});

test("a requeue gate (below the supplier-send cutoff) stops the push and says so", async () => {
  asReviewer();
  enqueueCoverForSupplier.mock.mockImplementationOnce(async () => "below-cutoff");
  const { body } = await call({ mode: "run", styleIds: ["st-1"] });
  const r = resultFor(body, "st-1");
  assert.equal(r.refreshed, true);
  assert.equal(r.requeue, "below-cutoff");
  assert.equal(r.outcome, "not-pushed");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0, "cutoff means no delivery at all");
});

test("the rebuild stamps the manifest fingerprint rather than nulling it", async () => {
  asReviewer();
  await call({ mode: "run", styleIds: ["st-1"] });
  const opts = refreshStyleCoverAsset.mock.calls[0]!.arguments[1]!;
  assert.equal(opts.stampManifest, true, "keeps the ledger honest for the next bulk sweep");
  assert.ok(!opts.onlyWhenChanged, "a typed style number must never be skipped as 'unchanged'");
  assert.ok(!opts.onlyWhenPending, "nor skipped for being fully approved");
});

test("notifySupplier defaults to off, is passed through, and reaches every style", async () => {
  asReviewer();
  await call({ mode: "run", styleIds: ["st-1"] });
  assert.deepEqual(enqueueCoverForSupplier.mock.calls[0]!.arguments[2], { notifySupplier: false });

  await call({ mode: "run", styleIds: ["st-1", "st-2"], notifySupplier: true });
  assert.deepEqual(enqueueCoverForSupplier.mock.calls[1]!.arguments[2], { notifySupplier: true });
  assert.deepEqual(enqueueCoverForSupplier.mock.calls[2]!.arguments[2], { notifySupplier: true });
});
