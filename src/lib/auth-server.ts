import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { db } from "./db";
import type { UserRole } from "@/generated/prisma/enums";

// Dev escape hatch. When AUTH_DISABLED=true the whole app runs as the first
// ADMIN user with no login required — handy for single-user / local work
// before real users are onboarded. Re-enable auth by removing the flag from
// the environment. NEVER set this on a public deployment: it removes ALL
// authentication. Every server-side gate (requireSession / requireRole /
// getSessionWithRole) funnels through getServerSession, so toggling it here
// covers them all; the middleware (proxy.ts) honours the same flag.
const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;

let warnedAuthDisabled = false;

// Synthesize a session for the first ADMIN (or, failing that, the first
// user). A REAL user id is required because review actions FK back to the
// User table — a fabricated id would violate the constraint.
async function devBypassSession(): Promise<ServerSession> {
  if (!warnedAuthDisabled) {
    console.warn(
      "[auth] AUTH_DISABLED=true — authentication is OFF; running as the first ADMIN user. Do not use in production.",
    );
    warnedAuthDisabled = true;
  }
  const user =
    (await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } })) ??
    (await db.user.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!user) {
    console.warn("[auth] AUTH_DISABLED=true but no user exists — sign up once, then the bypass can run as that user.");
    return null;
  }
  const now = new Date();
  return {
    session: {
      id: "dev-bypass",
      token: "dev-bypass",
      userId: user.id,
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user,
  } as unknown as ServerSession;
}

export async function getServerSession() {
  if (AUTH_DISABLED) return devBypassSession();
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
