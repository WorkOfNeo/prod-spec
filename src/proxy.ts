import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Pages reachable WITHOUT a session. Everything else redirects to /login.
const AUTH_PAGES = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);

// Of those, the ones that are pointless once you're signed in and so bounce
// you onward. /reset-password is deliberately NOT here: following a reset
// link while an old session is still alive is exactly the case where you
// most need the page to open (and finishing the reset kills that session).
const SIGNED_IN_REDIRECT = new Set(["/login", "/signup", "/forgot-password"]);

export function proxy(request: NextRequest) {
  // Dev escape hatch — auth fully disabled (see AUTH_DISABLED in
  // src/lib/auth-server.ts). Let every request through; no login required.
  if (process.env.AUTH_DISABLED === "true") {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (sessionCookie && SIGNED_IN_REDIRECT.has(pathname)) {
    return NextResponse.redirect(new URL("/styles", request.url));
  }

  if (!sessionCookie && !AUTH_PAGES.has(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/styles/:path*",
    "/jobs/:path*",
    "/settings/:path*",
    "/customers/:path*",
    "/suppliers/:path*",
    "/business-areas/:path*",
    "/prod-specs/:path*",
    "/sync/:path*",
    "/monday-inspect/:path*",
    "/users/:path*",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
  ],
};
