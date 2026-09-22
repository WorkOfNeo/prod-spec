// Role-gate + delete-blast-radius test for the manually-supplied packaging
// routes on a style:
//
//   GET/POST/PATCH /api/admin/styles/[id]/manual-trims
//   GET/DELETE     /api/admin/styles/[id]/manual-trims/[uploadId]
//
// Three things are under test, and the last two are the important ones:
//
//   1. The gate: attaching a document is canReview, not isAdmin. ADMIN and
//      REVIEWER pass, any other signed-in role is 403'd before the DB is
//      touched, no session is 401'd. AUTH_DISABLED forces ADMIN in dev, so
//      clicking around proves nothing about this — these assertions are the
//      only proof the widened gate holds.
//   2. WHAT DELETE CAN REACH. Widening upload access widens delete access with
//      it, and DELETE removes the file from the supplier's SharePoint folder as
//      well as the row. The assertions below pin its reach to the drive+item id
//      THIS feature recorded on a StyleManualTrimUpload of the style in the
//      path — never a name, never a path, never a folder. If someone later
//      makes this route look files up instead of reading its own row, they
//      fail.
//   3. THAT THE COVER LOOP IS CLOSED. Supplying or un-supplying a line only
//      moves a row in the database; the cover the supplier holds is a PDF, and
//      for one release nothing rebuilt it — the whole feature was invisible to
//      the person it was for. Every mutation here must now hand off to
//      refreshCoverAfterManualTrimChange, and no cover failure may undo an
//      action that already succeeded.
//   4. WHAT PATCH CAN REACH — which is nothing. "Approve by hand" exists
//      precisely because the document is already in the supplier's folder;
//      the app neither put it there nor may take it away. So PATCH must never
//      call Graph, in either direction, whatever it is asked to do. Same label
//      gate as POST, because a row keyed on a label the cover doesn't list is
//      a row nothing will ever read.
//
// Drives the REAL route handlers with a mocked session, a spy `db` and a spy
// Graph layer, so the gate is exercised end-to-end WITHOUT the live Railway DB
// or SharePoint.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── Mutable session state the auth mock reads at call time ──────────────────
let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
function asAdmin() {
  sessionState = { session: { user: { id: "admin-1", email: "admin@example.com" } }, role: "ADMIN" };
}
function asReviewer() {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
}
function asViewer() {
  // Signed in, but neither ADMIN nor REVIEWER — must be refused.
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── The style + manifest the handlers see ───────────────────────────────────
const STYLE_ID = "style-1";
const LABEL = "Hang Tag String";

const styleFindUnique = mock.fn(async () => ({
  id: STYLE_ID,
  name: "12345",
  mondayItemId: "9876543210",
  poNumber: "PO-TEST-1",
  supplierPoFolderName: null,
  supplier: { name: "Test Supplier", sharepointUrl: "https://example.invalid/share" },
}) as unknown);

const buildRequiredPackagingForStyle = mock.fn(async () => [
  { kind: "manual", displayName: LABEL },
  { kind: "generated", displayName: "Care Label" },
] as unknown);

// ── DB spies ────────────────────────────────────────────────────────────────
type FindFirstArgs = { where: Record<string, unknown>; select?: Record<string, unknown> };

const STORED_ROW = {
  id: "upload-1",
  sharepointDriveId: "drive-A",
  sharepointItemId: "item-A",
  trimLabel: LABEL,
  fileName: "12345 - Hang Tag String.pdf",
};

let lastUploadFindFirst: FindFirstArgs | null = null;
const uploadFindFirst = mock.fn(async (args: FindFirstArgs) => {
  lastUploadFindFirst = args;
  return STORED_ROW as unknown;
});
const uploadFindMany = mock.fn(async () => [] as unknown[]);
// What PATCH's "is there already a row for this line?" read returns. Default:
// a row that is nothing but a hand-approval (no bytes, never pushed).
const uploadFindUnique = mock.fn(
  async () => ({ id: "upload-1", fileName: null, sharepointItemId: null }) as unknown,
);
// Captured the same way lastUploadFindFirst is, so assertions can read back
// WHAT was written and not merely that something was.
type WriteArgs = { create?: Record<string, unknown>; update?: Record<string, unknown>; data?: Record<string, unknown> };
let lastUpsert: WriteArgs | null = null;
let lastUpdate: WriteArgs | null = null;
const uploadUpsert = mock.fn(async (args: WriteArgs) => {
  lastUpsert = args;
  return { id: "upload-1" };
});
const uploadUpdate = mock.fn(async (args: WriteArgs) => {
  lastUpdate = args;
  return {};
});
const uploadDelete = mock.fn(async () => ({}));

// ── SharePoint spies ────────────────────────────────────────────────────────
let removeArgs: Array<[string, string]> = [];
const removeFromApprovedLayouts = mock.fn(async (driveId: string, itemId: string) => {
  removeArgs.push([driveId, itemId]);
  return { deleted: true, alreadyGone: false };
});
const uploadIntoApprovedLayouts = mock.fn(async (input: { fileName: string }) => ({
  driveId: "drive-A",
  itemId: "item-A",
  fileName: input.fileName,
  webUrl: "https://example.invalid/file",
  folderUrl: "https://example.invalid/folder",
}));

// The cover-refresh hand-off. Spied rather than run: the real one pulls in
// puppeteer, and what is under test here is that each mutation calls it with
// this style's id — not how a PDF renders.
let coverRefreshCalls: string[] = [];
type CoverOutcome = {
  cover: string;
  requeue: string | null;
  pushed: number;
  message: string | null;
};
const refreshCoverAfterManualTrimChange = mock.fn(async (styleId: string): Promise<CoverOutcome> => {
  coverRefreshCalls.push(styleId);
  return { cover: "refreshed", requeue: "queued", pushed: 1, message: "Cover page updated." };
});

class ApprovedLayoutsFolderError extends Error {
  constructor(
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

before(() => {
  // The real canReview from @/lib/roles stays un-mocked — the gate's actual
  // predicate is what's under test. So do manual-upload-name and classify:
  // they're pure, and the file name is part of what DELETE is scoped to.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        style: { findUnique: styleFindUnique },
        styleManualTrimUpload: {
          findFirst: uploadFindFirst,
          findUnique: uploadFindUnique,
          findMany: uploadFindMany,
          upsert: uploadUpsert,
          update: uploadUpdate,
          delete: uploadDelete,
        },
        job: { findFirst: mock.fn(async () => ({ id: "job-1" })) },
        log: { create: mock.fn(async () => ({})) },
      },
    },
  });
  mock.module("@/lib/outputs/required-packaging", {
    namedExports: { buildRequiredPackagingForStyle },
  });
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getTrimsOnCoverEnabled: async () => true },
  });
  mock.module("@/lib/styles/render-context", {
    namedExports: {
      loadStyleRenderContext: async () => ({
        styleData: { styleNumber: "12345", colour: { name: "Black", code: null } },
      }),
    },
  });
  mock.module("@/lib/sharepoint/upload", {
    namedExports: { uploadIntoApprovedLayouts, removeFromApprovedLayouts, ApprovedLayoutsFolderError },
  });
  // ONLY the Safe name is exported here, deliberately. A route that reaches for
  // the unguarded refreshCoverAfterManualTrimChange gets undefined and blows up
  // in these tests — which is the point: the routes call an action that is
  // already committed, so they may only use the variant that cannot throw.
  mock.module("@/lib/trims/manual-trim-cover-refresh", {
    namedExports: { refreshCoverAfterManualTrimChangeSafe: refreshCoverAfterManualTrimChange },
  });
});

beforeEach(() => {
  styleFindUnique.mock.resetCalls();
  buildRequiredPackagingForStyle.mock.resetCalls();
  uploadFindFirst.mock.resetCalls();
  uploadFindUnique.mock.resetCalls();
  uploadFindMany.mock.resetCalls();
  uploadUpsert.mock.resetCalls();
  uploadUpdate.mock.resetCalls();
  uploadDelete.mock.resetCalls();
  removeFromApprovedLayouts.mock.resetCalls();
  uploadIntoApprovedLayouts.mock.resetCalls();
  removeArgs = [];
  coverRefreshCalls = [];
  refreshCoverAfterManualTrimChange.mock.resetCalls();
  lastUploadFindFirst = null;
  lastUpsert = null;
  lastUpdate = null;
});

// ── Driving the handlers ────────────────────────────────────────────────────
const base = `http://localhost/api/admin/styles/${STYLE_ID}/manual-trims`;
const listCtx = { params: Promise.resolve({ id: STYLE_ID }) };
const oneCtx = { params: Promise.resolve({ id: STYLE_ID, uploadId: "upload-1" }) };

async function readBody(res: Response) {
  try {
    return (await res.clone().json()) as {
      error?: string;
      ok?: boolean;
      deleted?: boolean;
      approved?: boolean;
    } | null;
  } catch {
    return null;
  }
}

async function listGet() {
  const mod = await import("@/app/api/admin/styles/[id]/manual-trims/route");
  const res = await mod.GET(new NextRequest(base), listCtx);
  return { status: res.status, body: await readBody(res) };
}

async function post(label = LABEL, fileName = "artwork.pdf") {
  const mod = await import("@/app/api/admin/styles/[id]/manual-trims/route");
  const form = new FormData();
  form.set("label", label);
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], fileName, { type: "application/pdf" }));
  const res = await mod.POST(new NextRequest(base, { method: "POST", body: form }), listCtx);
  return { status: res.status, body: await readBody(res) };
}

async function patch(approved: boolean, label = LABEL) {
  const mod = await import("@/app/api/admin/styles/[id]/manual-trims/route");
  const res = await mod.PATCH(
    new NextRequest(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, approved }),
    }),
    listCtx,
  );
  return { status: res.status, body: await readBody(res) };
}

async function del() {
  const mod = await import("@/app/api/admin/styles/[id]/manual-trims/[uploadId]/route");
  const res = await mod.DELETE(new NextRequest(`${base}/upload-1`, { method: "DELETE" }), oneCtx);
  return { status: res.status, body: await readBody(res) };
}

// ── The gate: uploading ─────────────────────────────────────────────────────

test("REVIEWER may attach a document (this is the whole point)", async () => {
  asReviewer();
  const { status, body } = await post();
  assert.equal(status, 200, "reviewer must be allowed through");
  assert.equal(body?.ok, true);
  assert.equal(uploadUpsert.mock.callCount(), 1, "the file was actually stored");
  assert.equal(uploadIntoApprovedLayouts.mock.callCount(), 1, "and pushed to APPROVED LAYOUTS");
});

test("ADMIN may attach a document", async () => {
  asAdmin();
  const { status } = await post();
  assert.equal(status, 200);
  assert.equal(uploadUpsert.mock.callCount(), 1);
});

test("a non-review role (VIEWER) can't upload — 403 before any DB work", async () => {
  asViewer();
  const { status, body } = await post();
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/, "403 body names the allowed roles");
  assert.equal(styleFindUnique.mock.callCount(), 0, "gate blocks before touching the DB");
  assert.equal(uploadUpsert.mock.callCount(), 0);
  assert.equal(uploadIntoApprovedLayouts.mock.callCount(), 0);
});

test("no session can't upload — 401", async () => {
  asAnon();
  const { status } = await post();
  assert.equal(status, 401);
  assert.equal(uploadUpsert.mock.callCount(), 0);
});

// ── The gate: reading the panel ─────────────────────────────────────────────
// The panel is a client component that renders whatever this GET returns, so
// a reviewer who can't call it sees an error box where the drop zones belong.
// Widening POST alone would not put the feature in front of reviewers.

test("REVIEWER may load the panel's zones", async () => {
  asReviewer();
  const { status } = await listGet();
  assert.equal(status, 200);
});

test("a non-review role (VIEWER) is refused the panel's zones", async () => {
  asViewer();
  const { status } = await listGet();
  assert.equal(status, 403);
  assert.equal(buildRequiredPackagingForStyle.mock.callCount(), 0);
});

// ── The gate: deleting ──────────────────────────────────────────────────────

test("REVIEWER may remove a document they (or anyone) attached", async () => {
  asReviewer();
  const { status, body } = await del();
  assert.equal(status, 200);
  assert.equal(body?.deleted, true);
  assert.equal(uploadDelete.mock.callCount(), 1);
});

test("a non-review role (VIEWER) can't delete — 403, and SharePoint is never called", async () => {
  asViewer();
  const { status, body } = await del();
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/);
  assert.equal(uploadFindFirst.mock.callCount(), 0, "gate blocks before touching the DB");
  assert.equal(removeFromApprovedLayouts.mock.callCount(), 0);
  assert.equal(uploadDelete.mock.callCount(), 0);
});

test("no session can't delete — 401", async () => {
  asAnon();
  const { status } = await del();
  assert.equal(status, 401);
  assert.equal(removeFromApprovedLayouts.mock.callCount(), 0);
});

// ── The blast radius of DELETE ──────────────────────────────────────────────

test("DELETE only ever hands Graph the drive+item id stored on ITS OWN row", async () => {
  asReviewer();
  await del();
  assert.deepEqual(
    removeArgs,
    [[STORED_ROW.sharepointDriveId, STORED_ROW.sharepointItemId]],
    "the ids come from the StyleManualTrimUpload row — never from a name, a path, or a folder listing",
  );
});

test("the row it reads is scoped to BOTH the upload id and the style in the path", async () => {
  asReviewer();
  await del();
  assert.ok(lastUploadFindFirst, "the row was looked up");
  assert.deepEqual(
    lastUploadFindFirst!.where,
    { id: "upload-1", styleId: STYLE_ID },
    "an upload id belonging to another style must not be reachable through this route",
  );
});

test("an upload id that isn't this style's deletes NOTHING and still reports success", async () => {
  asReviewer();
  // What the styleId-scoped findFirst returns for another style's upload id.
  uploadFindFirst.mock.mockImplementationOnce(async () => null as unknown);
  const { status, body } = await del();
  assert.equal(status, 200);
  assert.equal(body?.deleted, false, "idempotent: nothing of ours to remove");
  assert.equal(removeFromApprovedLayouts.mock.callCount(), 0, "no Graph delete for a row we don't own");
  assert.equal(uploadDelete.mock.callCount(), 0);
});

test("a row we never got into SharePoint triggers no Graph delete at all", async () => {
  asReviewer();
  uploadFindFirst.mock.mockImplementationOnce(
    async () => ({ ...STORED_ROW, sharepointDriveId: null, sharepointItemId: null }) as unknown,
  );
  const { status } = await del();
  assert.equal(status, 200);
  assert.equal(
    removeFromApprovedLayouts.mock.callCount(),
    0,
    "with no recorded item id there is nothing to delete — it must NOT go looking by file name",
  );
  assert.equal(uploadDelete.mock.callCount(), 1, "the local row still goes");
});

test("if SharePoint refuses, the row STAYS with the reason (409)", async () => {
  asReviewer();
  removeFromApprovedLayouts.mock.mockImplementationOnce(async () => {
    throw new Error("403 forbidden");
  });
  const { status, body } = await del();
  assert.equal(status, 409);
  assert.match(body?.error ?? "", /supplier's folder/);
  assert.equal(uploadDelete.mock.callCount(), 0, "never claim the folder is clean when it isn't");
  assert.equal(uploadUpdate.mock.callCount(), 1, "the reason is recorded on the row");
});

// ── The blast radius of POST ────────────────────────────────────────────────

test("a label that isn't a MANUAL manifest line is refused — no store, no push", async () => {
  asReviewer();
  const { status } = await post("Care Label"); // exists, but kind: "generated"
  assert.equal(status, 409);
  assert.equal(uploadUpsert.mock.callCount(), 0);
  assert.equal(uploadIntoApprovedLayouts.mock.callCount(), 0);
});

// ── The gate: approving by hand ─────────────────────────────────────────────

test("REVIEWER may approve a line by hand", async () => {
  asReviewer();
  const { status, body } = await patch(true);
  assert.equal(status, 200);
  assert.equal(body?.approved, true);
  assert.equal(uploadUpsert.mock.callCount(), 1, "the statement was recorded");
});

test("ADMIN may approve a line by hand", async () => {
  asAdmin();
  const { status } = await patch(true);
  assert.equal(status, 200);
  assert.equal(uploadUpsert.mock.callCount(), 1);
});

test("a non-review role (VIEWER) can't approve — 403 before any DB work", async () => {
  asViewer();
  const { status, body } = await patch(true);
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/);
  assert.equal(styleFindUnique.mock.callCount(), 0, "gate blocks before touching the DB");
  assert.equal(uploadUpsert.mock.callCount(), 0);
});

test("no session can't approve — 401", async () => {
  asAnon();
  const { status } = await patch(true);
  assert.equal(status, 401);
  assert.equal(uploadUpsert.mock.callCount(), 0);
});

// ── The blast radius of PATCH: zero ─────────────────────────────────────────
// The entire justification for this verb is that the document is ALREADY in the
// supplier's folder, put there by a person. So the app must not upload to that
// folder, and must not delete from it, on either edge of the switch. If someone
// later "helpfully" makes approving push the stored bytes, or makes undoing
// tidy the folder up, these fail — and they should.

test("approving by hand never touches SharePoint", async () => {
  asReviewer();
  await patch(true);
  assert.equal(uploadIntoApprovedLayouts.mock.callCount(), 0, "nothing is uploaded");
  assert.equal(removeFromApprovedLayouts.mock.callCount(), 0, "and nothing is removed");
});

test("withdrawing the approval never touches SharePoint either", async () => {
  asReviewer();
  await patch(false);
  assert.equal(removeFromApprovedLayouts.mock.callCount(), 0, "we did not put that file there");
  assert.equal(uploadIntoApprovedLayouts.mock.callCount(), 0);
});

// ── What PATCH writes ───────────────────────────────────────────────────────

test("approving stamps the row and attributes it to the signed-in user", async () => {
  asReviewer();
  await patch(true);
  assert.ok(lastUpsert, "the row was written");
  const { create, update } = lastUpsert! as Required<Pick<WriteArgs, "create" | "update">>;
  assert.equal(create.manualApprovedById, "rev-1", "who said it is part of the record");
  assert.ok(create.manualApprovedAt instanceof Date, "and when");
  assert.equal(create.trimLabel, LABEL, "labelled with the manifest's own wording");
  assert.equal(create.file, undefined, "a hand-approved row carries no bytes");
  assert.equal(update.uploadError, null, "a failed push the operator resolved stops nagging");
});

test("withdrawing drops a row that was nothing but the statement", async () => {
  asReviewer();
  const { status } = await patch(false);
  assert.equal(status, 200);
  assert.equal(uploadDelete.mock.callCount(), 1, "no bytes and no push — nothing left to keep");
  assert.equal(uploadUpdate.mock.callCount(), 0);
});

test("withdrawing KEEPS a row that also holds an uploaded file", async () => {
  asReviewer();
  uploadFindUnique.mock.mockImplementationOnce(
    async () =>
      ({ id: "upload-1", fileName: "12345-black-hang-tag.pdf", sharepointItemId: null }) as unknown,
  );
  const { status } = await patch(false);
  assert.equal(status, 200);
  assert.equal(uploadDelete.mock.callCount(), 0, "the operator's file must survive the undo");
  assert.equal(uploadUpdate.mock.callCount(), 1);
  assert.ok(lastUpdate, "the row was updated in place");
  assert.deepEqual(lastUpdate!.data, { manualApprovedAt: null, manualApprovedById: null });
});

test("withdrawing on a line with no row at all is a no-op success", async () => {
  asReviewer();
  uploadFindUnique.mock.mockImplementationOnce(async () => null as unknown);
  const { status, body } = await patch(false);
  assert.equal(status, 200);
  assert.equal(body?.approved, false);
  assert.equal(uploadDelete.mock.callCount(), 0);
  assert.equal(uploadUpdate.mock.callCount(), 0);
});

// ── The label gate, same as POST's ──────────────────────────────────────────

test("a label that isn't a MANUAL manifest line can't be approved", async () => {
  asReviewer();
  const { status } = await patch(true, "Care Label"); // exists, but kind: "generated"
  assert.equal(status, 409);
  assert.equal(uploadUpsert.mock.callCount(), 0, "no row for a line the cover never reads");
});

test("a label nothing on the cover lists at all can't be approved", async () => {
  asReviewer();
  const { status } = await patch(true, "Invented Trim");
  assert.equal(status, 409);
  assert.equal(uploadUpsert.mock.callCount(), 0);
});

test("`approved` must actually be a boolean — 400, no write", async () => {
  asReviewer();
  const mod = await import("@/app/api/admin/styles/[id]/manual-trims/route");
  const res = await mod.PATCH(
    new NextRequest(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: LABEL }),
    }),
    listCtx,
  );
  assert.equal(res.status, 400);
  assert.equal(uploadUpsert.mock.callCount(), 0);
});

// ── The cover loop ──────────────────────────────────────────────────────────
// The bug this section exists for: for one release every one of these mutations
// updated the manifest in the database and left the supplier holding a cover
// PDF that still said "Waiting for Customer Information". The feature worked
// everywhere except where anyone could see it. Each assertion below is one
// mutation that must hand the style off for a cover rebuild.

test("approving by hand rebuilds and re-pushes the cover", async () => {
  asReviewer();
  const { status, body } = await patch(true);
  assert.equal(status, 200);
  assert.deepEqual(coverRefreshCalls, [STYLE_ID], "the style's cover is rebuilt, once");
  assert.equal(
    (body as { cover?: { message?: string } })?.cover?.message,
    "Cover page updated.",
    "and the outcome comes back so the panel can say so",
  );
});

test("withdrawing an approval rebuilds the cover too", async () => {
  asReviewer();
  await patch(false);
  assert.deepEqual(
    coverRefreshCalls,
    [STYLE_ID],
    "a cover still claiming an un-supplied line is approved is the same leak in reverse",
  );
});

test("a successful upload rebuilds and re-pushes the cover", async () => {
  asReviewer();
  const { status } = await post();
  assert.equal(status, 200);
  assert.deepEqual(coverRefreshCalls, [STYLE_ID]);
});

test("removing a document rebuilds the cover", async () => {
  asReviewer();
  await del();
  assert.deepEqual(coverRefreshCalls, [STYLE_ID]);
});

test("an upload that never reached SharePoint does NOT rebuild the cover", async () => {
  asReviewer();
  uploadIntoApprovedLayouts.mock.mockImplementationOnce(async () => {
    throw new Error("no PO folder yet");
  });
  const { status, body } = await post();
  assert.equal(status, 200);
  assert.equal(body?.ok, true);
  assert.equal(
    coverRefreshCalls.length,
    0,
    "the line is not delivered, so the manifest did not move — rebuilding would overwrite a supplier's cover to change nothing",
  );
});

test("a refused label rebuilds nothing", async () => {
  asReviewer();
  await patch(true, "Care Label");
  assert.equal(coverRefreshCalls.length, 0);
});

test("the cover outcome is handed back so the panel can report a stale cover", async () => {
  asReviewer();
  refreshCoverAfterManualTrimChange.mock.mockImplementationOnce(async () => ({
    cover: "error",
    requeue: null,
    pushed: 0,
    message: "Saved, but the cover page couldn't be rebuilt: puppeteer died",
  }));
  const { status, body } = await patch(true);
  assert.equal(status, 200, "the approval stands even when the cover cannot be rebuilt");
  assert.equal(uploadUpsert.mock.callCount(), 1, "and it really was written");
  assert.match(
    (body as { cover?: { message?: string } })?.cover?.message ?? "",
    /couldn't be rebuilt/,
    "the reviewer is told the cover is stale rather than left guessing",
  );
});
