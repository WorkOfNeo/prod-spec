import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const AUTH_PAGES = new Set(["/login", "/signup"]);

export function proxy(request: NextRequest) {
  // Dev escape hatch — auth fully disabled (see AUTH_DISABLED in
  // src/lib/auth-server.ts). Let every request through; no login required.
  if (process.env.AUTH_DISABLED === "true") {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (sessionCookie && AUTH_PAGES.has(pathname)) {
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
  ],
};
