import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { db } from "./db";
import type { UserRole } from "@/generated/prisma/enums";

export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  return session;
}

export async function getSessionWithRole(): Promise<{
  session: Awaited<ReturnType<typeof getServerSession>>;
  role: UserRole | null;
}> {
  const session = await getServerSession();
  if (!session) return { session: null, role: null };
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  return { session, role: user?.role ?? null };
}

export type AuthCheck =
  | { ok: true; userId: string; role: UserRole }
  | { ok: false; status: 401 | 403; error: string };

export async function requireRole(roles: ReadonlyArray<UserRole> = ["ADMIN", "REVIEWER"]): Promise<AuthCheck> {
  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, status: 401, error: "Not signed in" };
  if (!role || !roles.includes(role)) {
    return { ok: false, status: 403, error: `Requires role: ${roles.join(" or ")}` };
  }
  return { ok: true, userId: session.user.id, role };
}
