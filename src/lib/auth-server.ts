import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { auth } from "./auth";
import { SIGN_IN_AGAIN } from "./auth-paths";
import { db } from "./db";
import type { UserRole } from "@/generated/prisma/enums";

// Dev escape hatch. When AUTH_DISABLED=true the whole app runs as the first
// ADMIN user with no login required — handy for single-user / local work
// before real users are onboarded. Re-enable auth by removing the flag from
// the environment. NEVER set this on a public deployment: it removes ALL
// authentication. Every server-side gate (requireSession / requireRole /
// getSessionWithRole / getServerSession) funnels through loadSession, so
// toggling it here covers them all; the middleware (proxy.ts) honours the
// same flag.
const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;
type SessionWithRole = { session: ServerSession; role: UserRole | null };

let warnedAuthDisabled = false;

// Synthesize a session for the first ADMIN (or, failing that, the first
// user). A REAL user id is required because review actions FK back to the
// User table — a fabricated id would violate the constraint.
async function devBypassSession(): Promise<SessionWithRole> {
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
    return { session: null, role: null };
  }
  const now = new Date();
  const session = {
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
  return { session, role: user.role };
}

// better-auth rewrites its cookie cache (see auth.ts) whenever getSession
// falls through to the database — but onto ITS response, which an auth.api
// call from server code throws away. Left alone, the only cache a browser
// ever held would be the one written at sign-in, dead five minutes later.
// So copy that one cookie onto our response wherever Next allows a write:
// route handlers, which the sidebar polls hit every minute. A Server
// Component render can't set cookies (set() throws — the next poll covers
// it), and a server action is skipped because a cookie write there makes Next
// re-render the page. Only the cache cookie is forwarded; the session token
// cookie keeps exactly the lifetime it has today.
async function keepCookieCacheWarm(authHeaders: Headers, requestHeaders: Headers) {
  const setCookie = authHeaders.get("set-cookie");
  if (!setCookie || requestHeaders.has("next-action")) return;
  const cacheCookies = [...parseSetCookieHeader(setCookie)].filter(([name]) =>
    name.includes(".session_data"),
  );
  if (cacheCookies.length === 0) return;
  try {
    const jar = await cookies();
    for (const [name, attrs] of cacheCookies) jar.set(name, attrs.value, toCookieOptions(attrs));
  } catch {
    // Server Component render — cookies are read-only here.
  }
}

// One lookup per request. The admin layout and the page under it both gate
// on the session; React's cache() memoizes per server render, so they share
// this instead of each paying for it. Route handlers aren't a React render —
// there cache() calls straight through, one lookup per call, as before.
const loadSession = cache(async (): Promise<SessionWithRole> => {
  if (AUTH_DISABLED) return devBypassSession();
  const requestHeaders = await headers();
  const { headers: authHeaders, response: session } = await auth.api.getSession({
    headers: requestHeaders,
    returnHeaders: true,
  });
  await keepCookieCacheWarm(authHeaders, requestHeaders);
  if (!session) return { session: null, role: null };
  // getSession may have answered from the cookie cache without touching the
  // database, which alone would let a revoked session — a password reset, a
  // removed user — keep working until the cookie runs out. So confirm the
  // session row is still live; the same single query reads the role (never
  // trusted from the cookie), so the gate stays one round trip. No row → no
  // session, never a session with a null role.
  const user = await db.user.findFirst({
    where: {
      id: session.user.id,
      sessions: { some: { token: session.session.token, expiresAt: { gt: new Date() } } },
    },
    select: { role: true },
  });
  if (!user) return { session: null, role: null };
  return { session, role: user.role };
});

export async function getServerSession(): Promise<ServerSession> {
  return (await loadSession()).session;
}

export async function requireSession() {
  const session = await getServerSession();
  if (!session) redirect(SIGN_IN_AGAIN);
  return session;
}

export async function getSessionWithRole(): Promise<{
  session: Awaited<ReturnType<typeof getServerSession>>;
  role: UserRole | null;
}> {
  return loadSession();
}

// Server-side gate for admin-only PAGES. REVIEWERs are scoped to My tasks,
// the styles pages and /settings/cover-page (which gates on canReview of its
// own accord rather than calling this) — a deep link anywhere else bounces to
// their dashboard. (API routes use requireRole; pages redirect instead of
// 403ing so a reviewer following an old link lands somewhere useful.)
export async function requireAdminPage() {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect(SIGN_IN_AGAIN);
  if (role !== "ADMIN") redirect("/dashboard");
  return session;
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
