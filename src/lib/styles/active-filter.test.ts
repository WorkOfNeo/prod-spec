import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@/generated/prisma/client";
import { activeStylesWhere, hasPoNumber } from "./active-filter";

// ---------------------------------------------------------------------------
// activeStylesWhere() is the ONE definition of "this style is on the board".
// /styles, /combos, /admin ▸ Config gaps and the Needs-input dashboard all
// read it precisely so they can't drift, which makes it worth testing at the
// level that actually matters: not "does the object have this key", but
// "would this style row come back".
//
// So the where-clause is EVALUATED here, against plain style rows, by the
// little interpreter below. It models only the handful of Prisma operators
// this module emits today and THROWS on anything else — so the day someone
// adds an operator it doesn't understand, these tests fail loudly instead of
// quietly passing on a clause they no longer check.
//
// Passing `doneCutoffIds` explicitly keeps the builder off the database, so
// this file needs no fixtures and no connection.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  poNumber: string | null;
  groupTitle: string | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  pulledForTestAt: Date | null;
};

// A live style: real PO, ordinary production group, nothing soft-deleted.
function style(over: Partial<Row> = {}): Row {
  return {
    id: "s-live",
    poNumber: "C-PO63144",
    groupTitle: "In production",
    archivedAt: null,
    deletedAt: null,
    pulledForTestAt: null,
    ...over,
  };
}

function matchesField(cond: unknown, value: unknown): boolean {
  if (cond === null) return value === null;
  if (typeof cond === "string") return value === cond;
  if (typeof cond !== "object") throw new Error(`interpreter: unmodelled filter ${String(cond)}`);
  const c = cond as Record<string, unknown>;
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case "mode":
        // Read together with `contains`; carries no truth of its own.
        break;
      case "not":
        if (arg === null) {
          if (value === null) return false;
        } else if (typeof arg === "string") {
          if (value === arg) return false;
        } else {
          throw new Error(`interpreter: unmodelled "not" argument ${JSON.stringify(arg)}`);
        }
        break;
      case "in":
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).includes(value)) return false;
        break;
      case "contains": {
        if (c.mode !== undefined && c.mode !== "insensitive") {
          throw new Error(`interpreter: unmodelled contains mode ${String(c.mode)}`);
        }
        // A NULL column never satisfies ILIKE. Prisma re-admits NULL rows from
        // negated filters on nullable columns, which the plain negation in
        // matchesWhere below reproduces — so a null groupTitle reads as
        // "not in a hidden group", exactly as Postgres answers it.
        if (typeof value !== "string") return false;
        if (!value.toLowerCase().includes(String(arg).toLowerCase())) return false;
        break;
      }
      default:
        throw new Error(`interpreter: unmodelled operator "${op}"`);
    }
  }
  return true;
}

function matchesWhere(where: Prisma.StyleWhereInput, row: Row): boolean {
  return Object.entries(where as Record<string, unknown>).every(([key, cond]) => {
    if (key === "OR") return (cond as Prisma.StyleWhereInput[]).some((w) => matchesWhere(w, row));
    if (key === "AND") return (cond as Prisma.StyleWhereInput[]).every((w) => matchesWhere(w, row));
    if (key === "NOT") {
      // Prisma negates each member of a NOT list and ANDs the results —
      // "none of these match". That is the behaviour /styles depends on: read
      // as a single negated conjunction instead, every Done-group style would
      // pass (no group title contains both "template" AND "done") and the
      // hidden-group filter would be a no-op.
      const list = (Array.isArray(cond) ? cond : [cond]) as Prisma.StyleWhereInput[];
      return list.every((w) => !matchesWhere(w, row));
    }
    if (!(key in row)) throw new Error(`interpreter: unmodelled column "${key}"`);
    return matchesField(cond, row[key as keyof Row]);
  });
}

const NO_CUTOFF = { doneCutoffIds: new Set<string>() };

// ── The PO-number gate ────────────────────────────────────────────────────
// "Navision Task" on the Monday Pre-Order board → Style.poNumber. Nothing can
// be generated without it, so a style without one is not on the board yet.

test("PO gate — a style with no PO number is not active", async () => {
  const where = await activeStylesWhere(NO_CUTOFF);
  assert.equal(matchesWhere(where, style({ poNumber: null })), false, "null PO must be hidden");
  assert.equal(matchesWhere(where, style({ poNumber: "" })), false, "empty PO must be hidden");
});

test("PO gate — a style WITH a PO number is active", async () => {
  const where = await activeStylesWhere(NO_CUTOFF);
  assert.equal(matchesWhere(where, style({ poNumber: "C-PO63144" })), true);
  assert.equal(matchesWhere(where, style({ poNumber: "63144" })), true);
  // Not parsed, just present — a non-numeric reference still counts as set.
  assert.equal(matchesWhere(where, style({ poNumber: "TBC" })), true);
});

test("PO gate — includeMissingPo opts the /styles list back into the full set", async () => {
  const where = await activeStylesWhere({ ...NO_CUTOFF, includeMissingPo: true });
  assert.equal(matchesWhere(where, style({ poNumber: null })), true);
  assert.equal(matchesWhere(where, style({ poNumber: "" })), true);
  // ...without loosening anything else: the hidden-group filter still bites.
  assert.equal(matchesWhere(where, style({ poNumber: null, groupTitle: "✅ Done" })), false);
});

test("PO gate — whitespace-only is caught in the app, not in SQL", async () => {
  const where = await activeStylesWhere(NO_CUTOFF);
  // Documented split, not an oversight: the where-clause covers the two shapes
  // the Monday sync writes (NULL / ""), and hasPoNumber — which every surface
  // rendering a row calls — is the trim-aware one.
  assert.equal(matchesWhere(where, style({ poNumber: "   " })), true);
  assert.equal(hasPoNumber("   "), false);
});

test("hasPoNumber — the one definition of a set PO number", () => {
  assert.equal(hasPoNumber(null), false);
  assert.equal(hasPoNumber(undefined), false);
  assert.equal(hasPoNumber(""), false);
  assert.equal(hasPoNumber("  \t "), false);
  assert.equal(hasPoNumber("C-PO63144"), true);
  assert.equal(hasPoNumber(" 63144 "), true);
});

// ── Regressions: everything the gate is AND-ed on top of ──────────────────

test("Done-group styles above the PO cutoff are still re-admitted", async () => {
  const done = style({ id: "s-done", groupTitle: "✅ Done", poNumber: "C-PO63144" });

  const gated = await activeStylesWhere(NO_CUTOFF);
  assert.equal(matchesWhere(gated, done), false, "Done group is hidden without a cutoff hit");

  const readmitted = await activeStylesWhere({ doneCutoffIds: new Set(["s-done"]) });
  assert.equal(matchesWhere(readmitted, done), true, "cutoff must still re-admit it");

  // The re-admission does NOT smuggle a PO-less style past the gate. Can't
  // arise through resolveDoneCutoffIds (it parses a PO to select ids in the
  // first place), but it pins the AND-above-the-OR shape.
  const poless = { ...done, poNumber: null };
  assert.equal(matchesWhere(readmitted, poless), false);
});

test("hidden groups, archived and deleted styles stay out", async () => {
  const where = await activeStylesWhere(NO_CUTOFF);
  assert.equal(matchesWhere(where, style({ groupTitle: "📋 Templates" })), false);
  assert.equal(matchesWhere(where, style({ groupTitle: "done" })), false);
  assert.equal(matchesWhere(where, style({ archivedAt: new Date() })), false);
  assert.equal(matchesWhere(where, style({ deletedAt: new Date() })), false);
  // A style Monday never grouped is not hidden — nullable NOT re-admits it.
  assert.equal(matchesWhere(where, style({ groupTitle: null })), true);
});

test("styles pulled in for layout testing are still re-admitted", async () => {
  const where = await activeStylesWhere(NO_CUTOFF);
  const pulled = style({ groupTitle: "✅ Done", pulledForTestAt: new Date() });
  assert.equal(matchesWhere(where, pulled), true);
  // Pulled BY PO, so it always carries one — and the gate holds regardless.
  assert.equal(matchesWhere(where, { ...pulled, poNumber: null }), false);
});
