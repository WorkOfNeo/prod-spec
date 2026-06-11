import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { UserRole } from "@/generated/prisma/enums";

export const runtime = "nodejs";

// True when this user is the only ADMIN — demoting or deleting them would
// lock everyone out of user management for good.
async function isLastAdmin(userId: string): Promise<boolean> {
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (target?.role !== "ADMIN") return false;
  const adminCount = await db.user.count({ where: { role: "ADMIN" } });
  return adminCount <= 1;
}

// Change a user's role. ADMIN only, last-admin guarded.
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
  const role = (body as { role?: unknown })?.role;
  if (role !== UserRole.ADMIN && role !== UserRole.REVIEWER) {
    return NextResponse.json({ error: "Body must be { role: \"ADMIN\" | \"REVIEWER\" }" }, { status: 400 });
  }

  const user = await db.user.findUnique({ where: { id }, select: { role: true, email: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (user.role === role) return NextResponse.json({ ok: true, role });

  if (role === UserRole.REVIEWER && (await isLastAdmin(id))) {
    return NextResponse.json(
      { error: "This is the last admin — promote someone else first." },
      { status: 409 },
    );
  }

  await db.user.update({ where: { id }, data: { role } });
  await db.log.create({
    data: { level: "INFO", message: `user ${user.email} role set to ${role} by user ${auth.userId}` },
  });
  return NextResponse.json({ ok: true, role });
}

// Remove a user. Sessions and accounts cascade; review history (actions,
// tickets) is FK-protected — those users can't be hard-deleted without
// losing the audit trail, so we refuse with a clear message instead.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (id === auth.userId) {
    return NextResponse.json(
      { error: "You can't remove your own account — ask another admin." },
      { status: 409 },
    );
  }

  const user = await db.user.findUnique({ where: { id }, select: { email: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (await isLastAdmin(id)) {
    return NextResponse.json(
      { error: "This is the last admin — promote someone else first." },
      { status: 409 },
    );
  }

  try {
    await db.user.delete({ where: { id } });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2003") {
      return NextResponse.json(
        {
          error:
            "This user has review history (approvals, rejections or tickets) that must stay attributed. Removal is blocked; demote them to REVIEWER or leave the account dormant.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  await db.log.create({
    data: { level: "INFO", message: `user ${user.email} removed by user ${auth.userId}` },
  });
  return NextResponse.json({ ok: true });
}
