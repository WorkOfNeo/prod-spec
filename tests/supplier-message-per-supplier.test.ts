// The follow-up message must go out as ONE EMAIL PER SUPPLIER — never a single
// email with 40 suppliers in the To or CC.
//
// This is not a style preference. The feature exists to apologise for a batch
// that went out wrong; an apology that discloses your whole supplier list to
// every competitor on it is a worse incident than the one it is correcting.
// Nothing in the code's shape stops a future refactor from "optimising" the
// per-supplier loop into one dispatch with a joined recipient list, so the
// property is pinned here: the REAL route handler is driven with three
// suppliers and the dispatches are asserted to be one per supplier with
// pairwise-disjoint recipients.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Three suppliers, deliberately awkward:
//   sup-a — one plain address
//   sup-b — a PACKED Monday field (two addresses in one string) plus a synced
//           contact, so it resolves to a To + 2 CC. The packed half must land
//           on sup-b's OWN cc, never on someone else's mail.
//   sup-c — company inbox empty, reachable only through a synced contact.
const SUPPLIERS = [
  { id: "sup-a", name: "Acme Textiles", email: "a@acme.example", contactEmail: null },
  { id: "sup-b", name: "Beta Knits", email: "b1@beta.example - b2@beta.example", contactEmail: null },
  { id: "sup-c", name: "Ceylon Mills", email: null, contactEmail: null },
];

const CONTACTS = new Map<string, string[]>([
  ["sup-b", ["bcontact@beta.example"]],
  ["sup-c", ["c@ceylon.example"]],
]);

// Every address in the fixture, mapped to the supplier that owns it — the basis
// for the cross-contamination assertion.
const OWNER_OF: Record<string, string> = {
  "a@acme.example": "sup-a",
  "b1@beta.example": "sup-b",
  "b2@beta.example": "sup-b",
  "bcontact@beta.example": "sup-b",
  "c@ceylon.example": "sup-c",
};

const BATCH = {
  id: "batch-1",
  perSupplier: SUPPLIERS.map((s) => ({
    supplierId: s.id,
    supplierName: s.name,
    email: null,
    status: "SENT",
  })),
};

type Dispatch = { to: string; cc?: string[]; subject: string; html: string; text: string };
let dispatches: Dispatch[] = [];
let batchUpdates: unknown[] = [];

before(() => {
  mock.module("@/lib/auth-server", {
    namedExports: {
      requireRole: async () => ({ ok: true, userId: "admin-1", role: "ADMIN" }),
    },
  });

  mock.module("@/lib/db", {
    namedExports: {
      db: {
        supplierSendBatch: {
          findUnique: async () => BATCH,
          update: async (args: unknown) => {
            batchUpdates.push(args);
            return {};
          },
        },
        supplier: {
          findMany: async (args: { where: { id: { in: string[] } } }) =>
            SUPPLIERS.filter((s) => args.where.id.in.includes(s.id)),
        },
      },
    },
  });

  mock.module("@/lib/suppliers/contact-emails", {
    namedExports: {
      loadContactEmailsBySupplier: async (ids: string[]) =>
        new Map(ids.map((id) => [id, CONTACTS.get(id) ?? []])),
    },
  });

  mock.module("@/lib/email/dispatch", {
    namedExports: {
      dispatchEmail: async (input: Dispatch) => {
        dispatches.push(input);
        return { status: "SENT", emailLogId: `log-${dispatches.length}`, note: null };
      },
    },
  });
});

beforeEach(() => {
  dispatches = [];
  batchUpdates = [];
});

const URL_ = "http://localhost/api/admin/supplier-send/batches/batch-1/message";
const ctx = { params: Promise.resolve({ id: "batch-1" }) };

async function send(supplierIds: string[]) {
  const { POST } = await import(
    "@/app/api/admin/supplier-send/batches/[id]/message/route"
  );
  const req = new NextRequest(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: "A correction for {{supplier}}",
      body: "Dear {{supplier}}, please disregard last night's email.",
      supplierIds,
    }),
  });
  const res = await POST(req, ctx);
  return { status: res.status, body: (await res.json()) as { sentCount: number } };
}

// Every address this dispatch reaches, To and CC together.
const recipientsOf = (d: Dispatch): string[] => [d.to, ...(d.cc ?? [])];

test("sends exactly one email per supplier, never one email to all of them", async () => {
  const { status, body } = await send(["sup-a", "sup-b", "sup-c"]);
  assert.equal(status, 200);
  assert.equal(body.sentCount, 3);

  // The property. Three suppliers ⇒ three dispatches, not one.
  assert.equal(dispatches.length, 3);

  // Each envelope carries exactly ONE address in To — a joined recipient list
  // is the exact shape this test exists to prevent.
  for (const d of dispatches) {
    assert.equal(typeof d.to, "string");
    assert.doesNotMatch(d.to, /[,;]/, `To must be a single address, got "${d.to}"`);
  }
});

test("no supplier can see another supplier's address", async () => {
  await send(["sup-a", "sup-b", "sup-c"]);

  for (const d of dispatches) {
    const owners = new Set(recipientsOf(d).map((addr) => OWNER_OF[addr]));
    assert.equal(
      owners.size,
      1,
      `one email reached addresses belonging to several suppliers: ${recipientsOf(d).join(", ")}`,
    );
  }

  // …and pairwise: no address appears in two different emails.
  const seen = new Map<string, number>();
  dispatches.forEach((d, i) => {
    for (const addr of recipientsOf(d)) {
      assert.equal(seen.has(addr), false, `${addr} appeared in emails ${seen.get(addr)} and ${i}`);
      seen.set(addr, i);
    }
  });
  assert.equal(seen.size, 5); // every fixture address reached, exactly once
});

test("a packed Monday email field stays on its OWN supplier's cc", async () => {
  await send(["sup-a", "sup-b", "sup-c"]);
  const beta = dispatches.find((d) => d.to.startsWith("b1@"));
  assert.ok(beta, "Beta Knits should be reachable via the first packed address");
  // "b1@… - b2@…" splits into To + cc, and the synced contact joins that cc —
  // all three belong to Beta, none leak to Acme or Ceylon.
  assert.deepEqual(beta.cc, ["b2@beta.example", "bcontact@beta.example"]);
});

test("each email is addressed to its own recipient, not to the list", async () => {
  await send(["sup-a", "sup-b", "sup-c"]);
  const bySupplier = Object.fromEntries(dispatches.map((d) => [OWNER_OF[d.to], d]));

  assert.match(bySupplier["sup-a"].subject, /A correction for Acme Textiles/);
  assert.match(bySupplier["sup-a"].html, /Dear Acme Textiles/);
  assert.match(bySupplier["sup-b"].subject, /A correction for Beta Knits/);
  assert.match(bySupplier["sup-c"].html, /Dear Ceylon Mills/);

  // No email mentions a supplier other than its own recipient.
  assert.doesNotMatch(bySupplier["sup-a"].html, /Beta Knits|Ceylon Mills/);
  assert.doesNotMatch(bySupplier["sup-c"].html, /Acme Textiles|Beta Knits/);
});

test("sending to a subset emails only that subset", async () => {
  const { body } = await send(["sup-a"]);
  assert.equal(body.sentCount, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].to, "a@acme.example");
});

test("a supplier not on the batch is refused, not quietly mailed", async () => {
  const { status } = await send(["sup-not-on-batch"]);
  assert.equal(status, 400);
  assert.equal(dispatches.length, 0);
});
