import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { createDraft, listRevisions } from "@/lib/output-layouts/revisions";
import {
  gateRevisionRoute,
  readJsonObject,
  revisionErrorResponse,
  toRevisionSummary,
} from "@/lib/output-layouts/revision-http";

export const runtime = "nodejs";

// A layout's revision history (design §5.1, §6). ADMIN only; 404 while
// CHANGE_REQUESTS_ENABLED is off.
//
// GET  → { revisions: RevisionSummary[] }, newest first, without the two
//        definition blobs (GET /revisions/[revisionId] has them).
// POST → a USER draft. Body { definition?, note? }: without a definition the
//        draft is a copy of the live layout — a starting point to edit and
//        review without touching what prints. A draft never goes live here;
//        only POST /revisions/[revisionId]/publish does that.

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const layout = await db.outputLayout.findUnique({ where: { id }, select: { id: true } });
  if (!layout) return NextResponse.json({ error: "Layout not found" }, { status: 404 });

  return NextResponse.json({ revisions: await listRevisions(id) });
}

const CREATE_SCHEMA = z.object({
  // Shape-checked by createDraft (strict schema, then parseLayoutDef), which
  // answers 422 { error, details } for one that isn't a real layout.
  definition: z.unknown().optional(),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = CREATE_SCHEMA.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  let definition = parsed.data.definition;
  if (definition === undefined) {
    const layout = await db.outputLayout.findUnique({ where: { id }, select: { definition: true } });
    if (!layout) return NextResponse.json({ error: "Layout not found" }, { status: 404 });
    definition = layout.definition;
  }

  try {
    const revision = await createDraft({
      layoutId: id,
      definition,
      authorKind: "USER",
      authorUserId: gate.userId,
      note: parsed.data.note || null,
    });
    return NextResponse.json({ revision: toRevisionSummary(revision) }, { status: 201 });
  } catch (err) {
    return revisionErrorResponse(err);
  }
}
