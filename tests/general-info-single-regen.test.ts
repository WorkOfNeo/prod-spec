// Role gate + blast radius for
// /api/admin/prod-specs/[id]/general-info/regenerate — the single-style
// "regenerate this one cover and re-upload it" escape hatch beside the General
// information editor.
//
// Four things are under test, and the last two are the ones that matter:
//
//   1. The gate: ADMIN and REVIEWER pass, another signed-in role is 403'd
//      before any DB work, no session is 401'd. Matches the sibling
//      general-info route — reviewers own this prose.
//   2. Resolution: a style number is NOT unique in this data (one Pre-Order row
//      per PO, two colourways per number), so several matches must come back as
//      a choice, never silently narrowed to one.
//   3. THE SCOPE GUARD. `run` must refuse a style belonging to a different prod
//      spec. A cover renders its own spec's General information, so acting on a
//      foreign style would publish another client's text into a supplier's
//      folder.
//   4. NO ProdSpec WRITE. The full /api/admin/prod-specs/<id> PATCH
//      auto-activates a draft spec on any content change (its `hasOtherChange`
//      counts generalInfoMd) — which is what makes a spec eligible for job
//      auto-enqueue. This route deliberately never goes through it. The
//      assertions below pin that: db.prodSpec.update is never called, on any
//      path. If someone later routes this through the generic PATCH, they fail.
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
    // Same style NUMBER, different order — the ordinary ambiguity.
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
    // Belongs to a DIFFERENT prod spec — `run` must refuse it.
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
const prodSpecFindUnique = mock.fn(async () => SPEC as unknown);
// The canary: this route must NEVER write a ProdSpec column.
const prodSpecUpdate = mock.fn(async () => ({}) as unknown);

const styleFindMany = mock.fn(async (args: { where: { name: { contains: string } } }) => {
  const q = args.where.name.contains.toLowerCase();
  return STYLES.filter((s) => s.name.toLowerCase().includes(q)) as unknown;
});
const styleFindUnique = mock.fn(
  async (args: { where: { id: string } }) =>
    (STYLES.find((s) => s.id === args.where.id) ?? null) as unknown,
);
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

const refreshStyleCoverAsset = mock.fn<
  (styleId: string, opts?: RefreshOpts) => Promise<RefreshResult>
>(async (styleId) => ({
  styleId,
  status: "refreshed",
  coverAssetId: "asset-1",
  jobId: "job-1",
}));
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
        style: { findMany: styleFindMany, findUnique: styleFindUnique },
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
    styleFindUnique,
    jobFindMany,
    queueFindUnique,
    logCreate,
    refreshStyleCoverAsset,
    enqueueCoverForSupplier,
    pushQueuedSupplierUploads,
  ]) {
    m.mock.resetCalls();
  }
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

// ── 1. The gate ─────────────────────────────────────────────────────────────

test("REVIEWER may regenerate a single style", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(status, 200);
  assert.equal(body.refreshed, true);
});

test("ADMIN may regenerate a single style", async () => {
  asAdmin();
  const { status } = await call({ mode: "run", styleId: "st-1" });
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
  const { status } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(status, 401);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0);
});

// ── 2. Resolution ───────────────────────────────────────────────────────────

test("two styles sharing a number come back as a choice, not a guess", async () => {
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
  assert.equal(body.matches[0].prodSpecName, "Other · Bags", "names where it does belong");
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

// ── 3. The scope guard ──────────────────────────────────────────────────────

test("run REFUSES a style belonging to a different prod spec", async () => {
  asReviewer();
  const { status, body } = await call({ mode: "run", styleId: "st-9" });
  assert.equal(status, 409);
  assert.match(body.error, /Other · Bags/, "the refusal names the spec it does belong to");
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0, "nothing is rebuilt");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0, "nothing is pushed");
});

test("run on an unknown style is 404'd, never rendered", async () => {
  asReviewer();
  const { status } = await call({ mode: "run", styleId: "nope" });
  assert.equal(status, 404);
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 0);
});

test("the run is scoped to exactly one style — no fan-out", async () => {
  asReviewer();
  await call({ mode: "run", styleId: "st-1" });
  assert.equal(refreshStyleCoverAsset.mock.callCount(), 1);
  assert.equal(refreshStyleCoverAsset.mock.calls[0]!.arguments[0], "st-1");
  assert.equal(enqueueCoverForSupplier.mock.callCount(), 1);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 1);
  const pushArgs = pushQueuedSupplierUploads.mock.calls[0]!.arguments[0]!;
  assert.deepEqual(pushArgs.styleIds, ["st-1"], "the push carries this style id and no other");
});

// ── 4. The draft-activation constraint ──────────────────────────────────────

test("NO ProdSpec column is ever written — the spec cannot be auto-activated", async () => {
  asReviewer();
  await call({ mode: "resolve", styleNumber: "AA10001" });
  await call({ mode: "run", styleId: "st-1" });
  await call({ mode: "run", styleId: "st-9" });
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
  const { body } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(body.refreshed, true);
  assert.equal(body.requeue, "queued");
  assert.equal(body.pushed, 1);
  assert.equal(body.pushFailed, 0);
  assert.equal(body.folderUrl, "https://example.invalid/approved-layouts");
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
  const { body } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(body.refreshed, true, "the rebuild did happen");
  assert.equal(body.pushFailed, 1, "and the push did not — reported separately");
  assert.equal(body.pushError, "write refused");
});

test("a style with no cover yet is explained, not rendered or pushed", async () => {
  asReviewer();
  refreshStyleCoverAsset.mock.mockImplementationOnce(async (styleId: string) => ({
    styleId,
    status: "no-cover" as const,
  }));
  const { status, body } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(status, 200);
  assert.equal(body.refreshed, false);
  assert.equal(body.reason, "no-cover");
  assert.match(body.message, /never generated/);
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0, "nothing to push");
});

test("a requeue gate (below the supplier-send cutoff) stops the push and says so", async () => {
  asReviewer();
  enqueueCoverForSupplier.mock.mockImplementationOnce(async () => "below-cutoff");
  const { body } = await call({ mode: "run", styleId: "st-1" });
  assert.equal(body.refreshed, true);
  assert.equal(body.requeue, "below-cutoff");
  assert.equal(pushQueuedSupplierUploads.mock.callCount(), 0, "cutoff means no delivery at all");
});

test("the rebuild stamps the manifest fingerprint rather than nulling it", async () => {
  asReviewer();
  await call({ mode: "run", styleId: "st-1" });
  const opts = refreshStyleCoverAsset.mock.calls[0]!.arguments[1]!;
  assert.equal(opts.stampManifest, true, "keeps the ledger honest for the next bulk sweep");
  assert.ok(!opts.onlyWhenChanged, "a typed style number must never be skipped as 'unchanged'");
  assert.ok(!opts.onlyWhenPending, "nor skipped for being fully approved");
});

test("notifySupplier defaults to off and is passed through when asked for", async () => {
  asReviewer();
  await call({ mode: "run", styleId: "st-1" });
  assert.deepEqual(enqueueCoverForSupplier.mock.calls[0]!.arguments[2], { notifySupplier: false });

  await call({ mode: "run", styleId: "st-1", notifySupplier: true });
  assert.deepEqual(enqueueCoverForSupplier.mock.calls[1]!.arguments[2], { notifySupplier: true });
});
