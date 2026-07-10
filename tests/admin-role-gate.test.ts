// Both-roles authorization test for the ADMIN-only API routes that were
// hardened against the REVIEWER role. Drives each REAL route handler with a
// mocked session (ADMIN / REVIEWER / no-session / automation-secret) and
// stubs every side-effecting dependency, so it exercises the gate end-to-end
// WITHOUT touching the live Railway DB, the queue, Puppeteer, or email.
//
// Requires Node's module-mock API, so it runs under its own npm script:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// JOB_RUNNER_SECRET isn't loaded from .env in the test runner — set a known
// value so the automation (secret) path of jobs/run + po-eans/run is testable.
const SECRET = "test-job-runner-secret";
process.env.JOB_RUNNER_SECRET = SECRET;

// ── Mutable session state the auth mock reads at call time ──────────────────
type Role = "ADMIN" | "REVIEWER" | "VIEWER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
function asAdmin() {
  sessionState = { session: { user: { id: "admin-1", email: "admin@example.com" } }, role: "ADMIN" };
}
function asReviewer() {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
}
function asViewer() {
  // Signed in but NEITHER ADMIN nor REVIEWER — must be refused by canReview gates.
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── Side-effect spies ───────────────────────────────────────────────────────
const findRejectionTicket = mock.fn(async () => null as unknown);
const findStyle = mock.fn(async () => null as unknown);
const runPendingJobs = mock.fn(async () => ({ processed: 0, failed: 0, jobIds: [] as string[] }));
const runPendingEanResolutions = mock.fn(async () => ({ processed: 0, failed: 0, requeued: 0, styleIds: [] }));
let autoRunEnabled = true;

class TicketRunError extends Error {
  httpStatus = 500;
}

// push-to-supplier spies (the two ADMIN-only routes added with this feature).
const findJobAsset = mock.fn(async () => null as unknown);
const getOutputs = mock.fn(async () => [] as unknown[]);
const pushApproved = mock.fn(async () => ({
  dryRun: false,
  supplierName: "",
  folderName: "",
  supplierFolderUrl: null,
  targetFolderUrl: null,
  pushed: [],
  skipped: [],
}));
class SupplierPushError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

before(() => {
  // Real isAdmin/canReview from @/lib/roles stay un-mocked — the gate's actual
  // predicate is what we want under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  // Mocking @/lib/db here also covers any transitive importer, so no real
  // Prisma/pg client is ever instantiated.
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        rejectionTicket: { findUnique: findRejectionTicket },
        style: { findUnique: findStyle },
        jobAsset: { findUnique: findJobAsset },
        // cron-activity routes (jobs/run, po-eans/run) record a CronRun on the
        // session/sweep path — stub it so the ADMIN happy-path tests pass.
        cronRun: { create: mock.fn(async () => ({})) },
      },
    },
  });
  // push-to-supplier deps stubbed so the gate tests never load the Graph SDK
  // or read the live DB. The ADMIN paths stop short of calling pushApproved
  // (bogus id 404s; empty approved set 409s), so the stub return is unused.
  mock.module("@/lib/outputs/current-outputs", {
    namedExports: { getCurrentOutputsForStyle: getOutputs },
  });
  mock.module("@/lib/sharepoint/push-to-supplier", {
    namedExports: { pushApprovedAssetsToSupplier: pushApproved, SupplierPushError },
  });
  // Happy-path executors → spies (also keeps Puppeteer/render stack unloaded).
  mock.module("@/lib/queue/runner", { namedExports: { runPendingJobs } });
  mock.module("@/lib/queue/enqueue", { namedExports: { enqueueGenerationJob: mock.fn(async () => ({ jobId: "job-1" })) } });
  mock.module("@/lib/po/ean-runner", { namedExports: { runPendingEanResolutions } });
  mock.module("@/lib/tickets/run-ticket-job", { namedExports: { runTicketJob: mock.fn(async () => ({ jobStatus: "DONE", jobId: "job-1", latestAsset: null })), TicketRunError } });
  mock.module("@/lib/settings/app-settings", {
    namedExports: {
      getPoEanAutoRunEnabled: async () => autoRunEnabled,
      getReviewNotificationEmails: async () => [],
    },
  });
  mock.module("@/lib/email/dispatch", { namedExports: { dispatchEmail: mock.fn(async () => ({ status: "SENT", to: "" })) } });
  mock.module("@/lib/email/templates/review-notification", { namedExports: { ticketFixedEmail: () => ({ subject: "", html: "", text: "" }) } });
  mock.module("@/lib/notifications/user-notifications", { namedExports: { notifyUser: mock.fn(async () => {}) } });
});

beforeEach(() => {
  findRejectionTicket.mock.resetCalls();
  findStyle.mock.resetCalls();
  runPendingJobs.mock.resetCalls();
  runPendingEanResolutions.mock.resetCalls();
  findJobAsset.mock.resetCalls();
  getOutputs.mock.resetCalls();
  pushApproved.mock.resetCalls();
  autoRunEnabled = true;
});

// Lazily import the route handlers AFTER mocks are registered.
async function load(path: string) {
  const mod = await import(path);
  return mod.POST as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
}
const ctx = { params: Promise.resolve({ id: "bogus-id" }) };
const post = (url: string) => new NextRequest(url, { method: "POST" });

async function call(POST: Awaited<ReturnType<typeof load>>, url: string) {
  const res = await POST(post(url), ctx);
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: body as { error?: string } | null };
}

// ── The four interactive ADMIN-only routes ──────────────────────────────────
// REVIEWER → 403 (and the handler never reaches the DB lookup); ADMIN passes
// the gate and is stopped only by the bogus id (404), proving the gate let
// them through; no session → 401.
const INTERACTIVE = [
  {
    name: "rejection-tickets/[id]/start",
    path: "@/app/api/admin/rejection-tickets/[id]/start/route",
    url: "http://localhost/api/admin/rejection-tickets/bogus-id/start",
    spy: findRejectionTicket,
  },
  {
    name: "rejection-tickets/[id]/fix",
    path: "@/app/api/admin/rejection-tickets/[id]/fix/route",
    url: "http://localhost/api/admin/rejection-tickets/bogus-id/fix",
    spy: findRejectionTicket,
  },
  {
    name: "rejection-tickets/[id]/rerun",
    path: "@/app/api/admin/rejection-tickets/[id]/rerun/route",
    url: "http://localhost/api/admin/rejection-tickets/bogus-id/rerun",
    spy: findRejectionTicket,
  },
  // styles/[id]/rerun moved OUT of this list — it's reviewer-accessible now
  // (canReview, like carton-customize); its gate tests live below.
  {
    name: "admin/job-assets/[id]/push-to-supplier",
    path: "@/app/api/admin/job-assets/[id]/push-to-supplier/route",
    url: "http://localhost/api/admin/job-assets/bogus-id/push-to-supplier",
    spy: findJobAsset,
  },
] as const;

for (const route of INTERACTIVE) {
  test(`${route.name}: REVIEWER is refused with 403 before any work`, async () => {
    const POST = await load(route.path);
    asReviewer();
    const { status, body } = await call(POST, route.url);
    assert.equal(status, 403, "reviewer must be forbidden");
    assert.match(body?.error ?? "", /ADMIN/, "403 body names the required role");
    assert.equal(route.spy.mock.callCount(), 0, "gate must block before touching the DB");
  });

  test(`${route.name}: ADMIN passes the gate`, async () => {
    const POST = await load(route.path);
    asAdmin();
    const { status } = await call(POST, route.url);
    assert.notEqual(status, 403, "admin must not be forbidden");
    assert.notEqual(status, 401, "admin must not be unauthorized");
    assert.equal(status, 404, "bogus id 404s — i.e. execution proceeded past the gate");
    assert.equal(route.spy.mock.callCount(), 1, "admin reaches the DB lookup");
  });

  test(`${route.name}: no session is rejected with 401`, async () => {
    const POST = await load(route.path);
    asAnon();
    const { status } = await call(POST, route.url);
    assert.equal(status, 401);
    assert.equal(route.spy.mock.callCount(), 0);
  });
}

// ── styles/[id]/rerun — reviewer-ACCESSIBLE (canReview, like carton-customize):
// reviewers regenerate outputs from the review screen after a data change.
// Bogus id → 404 proves execution proceeded past the gate.
const RERUN_PATH = "@/app/api/admin/styles/[id]/rerun/route";
const RERUN_URL = "http://localhost/api/admin/styles/bogus-id/rerun";

test("styles/[id]/rerun: REVIEWER passes the gate (the point of the change)", async () => {
  const POST = await load(RERUN_PATH);
  asReviewer();
  const { status } = await call(POST, RERUN_URL);
  assert.notEqual(status, 401, "reviewer must not be unauthorized");
  assert.notEqual(status, 403, "reviewer must NOT be forbidden — they may rerun outputs");
  assert.equal(status, 404, "bogus id 404s — i.e. execution proceeded past the gate");
  assert.equal(findStyle.mock.callCount(), 1, "reviewer reaches the style lookup");
});

test("styles/[id]/rerun: ADMIN passes the gate", async () => {
  const POST = await load(RERUN_PATH);
  asAdmin();
  const { status } = await call(POST, RERUN_URL);
  assert.notEqual(status, 403);
  assert.notEqual(status, 401);
  assert.equal(status, 404);
  assert.equal(findStyle.mock.callCount(), 1);
});

test("styles/[id]/rerun: a non-review role (VIEWER) is refused with 403 before any work", async () => {
  const POST = await load(RERUN_PATH);
  asViewer();
  const { status, body } = await call(POST, RERUN_URL);
  assert.equal(status, 403, "only ADMIN/REVIEWER may rerun");
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/, "403 body names the allowed roles");
  assert.equal(findStyle.mock.callCount(), 0, "gate blocks before touching the DB");
});

test("styles/[id]/rerun: no session is rejected with 401", async () => {
  const POST = await load(RERUN_PATH);
  asAnon();
  const { status } = await call(POST, RERUN_URL);
  assert.equal(status, 401);
  assert.equal(findStyle.mock.callCount(), 0);
});

// ── jobs/run — dual auth: secret (automation) bypasses role; session is ADMIN-only
test("jobs/run: REVIEWER session (no secret) → 403, queue not drained", async () => {
  const POST = await load("@/app/api/jobs/run/route");
  asReviewer();
  const { status, body } = await call(POST, "http://localhost/api/jobs/run");
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN/);
  assert.equal(runPendingJobs.mock.callCount(), 0);
});

test("jobs/run: ADMIN session → runs the queue", async () => {
  const POST = await load("@/app/api/jobs/run/route");
  asAdmin();
  const { status } = await call(POST, "http://localhost/api/jobs/run");
  assert.equal(status, 200);
  assert.equal(runPendingJobs.mock.callCount(), 1);
});

test("jobs/run: automation secret runs the queue even with NO session (role-agnostic)", async () => {
  const POST = await load("@/app/api/jobs/run/route");
  asAnon();
  const { status } = await call(POST, `http://localhost/api/jobs/run?secret=${SECRET}`);
  assert.equal(status, 200, "secret path must not require a session");
  assert.equal(runPendingJobs.mock.callCount(), 1);
});

test("jobs/run: no secret + no session → 401", async () => {
  const POST = await load("@/app/api/jobs/run/route");
  asAnon();
  const { status } = await call(POST, "http://localhost/api/jobs/run");
  assert.equal(status, 401);
  assert.equal(runPendingJobs.mock.callCount(), 0);
});

// ── po-eans/run — same dual auth, plus the auto-run switch on the secret path
test("po-eans/run: REVIEWER session (no secret) → 403, scraper not run", async () => {
  const POST = await load("@/app/api/po-eans/run/route");
  asReviewer();
  const { status, body } = await call(POST, "http://localhost/api/po-eans/run");
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN/);
  assert.equal(runPendingEanResolutions.mock.callCount(), 0);
});

test("po-eans/run: ADMIN session → runs the scraper", async () => {
  const POST = await load("@/app/api/po-eans/run/route");
  asAdmin();
  const { status } = await call(POST, "http://localhost/api/po-eans/run");
  assert.equal(status, 200);
  assert.equal(runPendingEanResolutions.mock.callCount(), 1);
});

test("po-eans/run: automation secret runs with NO session (role-agnostic)", async () => {
  const POST = await load("@/app/api/po-eans/run/route");
  asAnon();
  const { status } = await call(POST, `http://localhost/api/po-eans/run?secret=${SECRET}`);
  assert.equal(status, 200);
  assert.equal(runPendingEanResolutions.mock.callCount(), 1);
});

test("po-eans/run: automation secret no-ops (skipped) when auto-run is OFF — scraper not run", async () => {
  const POST = await load("@/app/api/po-eans/run/route");
  asAnon();
  autoRunEnabled = false;
  const { status, body } = await call(POST, `http://localhost/api/po-eans/run?secret=${SECRET}`);
  assert.equal(status, 200);
  assert.equal((body as { skipped?: boolean })?.skipped, true);
  assert.equal(runPendingEanResolutions.mock.callCount(), 0, "auto-run gate still suppresses cron work");
});

test("po-eans/run: no secret + no session → 401", async () => {
  const POST = await load("@/app/api/po-eans/run/route");
  asAnon();
  const { status } = await call(POST, "http://localhost/api/po-eans/run");
  assert.equal(status, 401);
  assert.equal(runPendingEanResolutions.mock.callCount(), 0);
});

// ── admin/styles/[id]/push-to-supplier — ADMIN-only "Push all". Doesn't fit
// the INTERACTIVE table (an ADMIN with no approved outputs is stopped at 409,
// not 404), so it gets its own trio. The 409 still proves the gate let the
// admin through, and that no push is attempted with nothing approved.
const STYLE_PUSH = "@/app/api/admin/styles/[id]/push-to-supplier/route";
const STYLE_PUSH_URL = "http://localhost/api/admin/styles/bogus-id/push-to-supplier";

test("styles/[id]/push-to-supplier: REVIEWER is refused with 403 before any work", async () => {
  const POST = await load(STYLE_PUSH);
  asReviewer();
  const { status, body } = await call(POST, STYLE_PUSH_URL);
  assert.equal(status, 403, "reviewer must be forbidden");
  assert.match(body?.error ?? "", /ADMIN/, "403 body names the required role");
  assert.equal(getOutputs.mock.callCount(), 0, "gate blocks before reading outputs");
  assert.equal(pushApproved.mock.callCount(), 0, "gate blocks before any push");
});

test("styles/[id]/push-to-supplier: ADMIN passes the gate (409 — nothing approved to push)", async () => {
  const POST = await load(STYLE_PUSH);
  asAdmin();
  const { status } = await call(POST, STYLE_PUSH_URL);
  assert.notEqual(status, 403, "admin must not be forbidden");
  assert.notEqual(status, 401, "admin must not be unauthorized");
  assert.equal(status, 409, "gate passed; empty approved set 409s");
  assert.equal(getOutputs.mock.callCount(), 1, "admin reaches the outputs read");
  assert.equal(pushApproved.mock.callCount(), 0, "no approved outputs → no push attempted");
});

test("styles/[id]/push-to-supplier: no session is rejected with 401", async () => {
  const POST = await load(STYLE_PUSH);
  asAnon();
  const { status } = await call(POST, STYLE_PUSH_URL);
  assert.equal(status, 401);
  assert.equal(getOutputs.mock.callCount(), 0);
});
