import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { invalidateLayoutImageCache } from "@/lib/output-layouts/images";
import { IMAGE_SLUG_RE } from "@/lib/output-layouts/image-slug";

export const runtime = "nodejs";

const PATCH_SCHEMA = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(IMAGE_SLUG_RE, "use lowercase letters, digits and hyphens, e.g. coop-hanger")
    .optional(),
  image: z.string().max(1_000_000).nullable().optional(),
  active: z.boolean().optional(),
});

// Which layouts place {{image:<slug>}}? The slug is the only link between a
// picture and the layouts that print it — there's no foreign key to lean on,
// because the reference lives inside the layout's JSON definition. Renaming
// or removing a picture that's in use silently turns those prints into
// `missing` chips, so both operations report the damage first and only
// proceed with ?force=1.
async function layoutsPlacing(slug: string): Promise<string[]> {
  const rows = await db.outputLayout.findMany({ select: { name: true, definition: true } });
  const needle = `{{image:${slug}`; // prefix — catches {{image:slug}} and {{image:slug:40}}
  return rows
    .filter((r) => JSON.stringify(r.definition ?? {}).includes(needle))
    .map((r) => r.name)
    .sort();
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PATCH_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const current = await db.layoutImage.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.slug !== undefined && parsed.data.slug !== current.slug) {
    const clash = await db.layoutImage.findUnique({ where: { slug: parsed.data.slug } });
    if (clash) {
      return NextResponse.json(
        { error: `The name "${parsed.data.slug}" is already taken by "${clash.name}"` },
        { status: 409 },
      );
    }
    const used = await layoutsPlacing(current.slug);
    if (used.length > 0 && req.nextUrl.searchParams.get("force") !== "1") {
      return NextResponse.json(
        {
          error:
            `Renaming to "${parsed.data.slug}" would break ${used.length} layout(s) that place ` +
            `{{image:${current.slug}}} — they'd print a "no artwork" placeholder until each one is repointed.`,
          layouts: used,
        },
        { status: 409 },
      );
    }
  }

  const updated = await db.layoutImage.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
      ...(parsed.data.image !== undefined ? { image: parsed.data.image } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  });
  // The library is read at render time (not baked into the layout variant),
  // so busting its cache is all a published layout needs to pick up new
  // artwork — no republish, no variant refresh.
  invalidateLayoutImageCache();
  return NextResponse.json({ image: updated });
}

// Hard-delete. Soft-delete is `PATCH { active: false }` — but note that a
// deactivated picture resolves exactly like a deleted one at render time
// (both print the `missing` chip), so neither is a way to quietly retire
// artwork that layouts still place. Blocked while in use unless ?force=1.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const current = await db.layoutImage.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const used = await layoutsPlacing(current.slug);
  if (used.length > 0 && req.nextUrl.searchParams.get("force") !== "1") {
    return NextResponse.json(
      {
        error:
          `${used.length} layout(s) place {{image:${current.slug}}} — deleting it makes them print a ` +
          `"no artwork" placeholder, which blocks approval.`,
        layouts: used,
      },
      { status: 409 },
    );
  }

  await db.layoutImage.delete({ where: { id } });
  invalidateLayoutImageCache();
  return NextResponse.json({ ok: true });
}
