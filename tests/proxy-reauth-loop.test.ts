// The proxy's sign-in bounce must not loop with a server gate. A browser can
// hold a session cookie whose session is dead (expired, revoked by a password
// reset, the user removed): the proxy, judging by the cookie alone, bounces
// /login to /styles, and the admin layout, finding no live session, sends it
// back to /login — "too many redirects". Server gates send such a request to
// SIGN_IN_AGAIN, which the proxy lets through to the form.
//
// Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SIGN_IN_AGAIN } from "@/lib/auth-paths";

const COOKIE = "better-auth.session_token=dead-token.signature";
const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, "https://prod-spec.example"), cookie ? { headers: { cookie } } : undefined);
const location = (res: Response) => res.headers.get("location");

test("a cookie on plain /login still bounces to /styles (signed-in users skip the form)", () => {
  const res = proxy(req("/login", COOKIE));
  assert.equal(new URL(location(res)!).pathname, "/styles");
});

test("a server gate's sign-in-again URL opens the form even with a cookie", () => {
  const res = proxy(req(SIGN_IN_AGAIN, COOKIE));
  assert.equal(location(res), null);
});

test("no cookie: protected pages still go to /login, the sign-in-again URL opens", () => {
  assert.equal(new URL(location(proxy(req("/styles")))!).pathname, "/login");
  assert.equal(location(proxy(req(SIGN_IN_AGAIN))), null);
});

test("the marker only unlocks the auth pages, never a protected page", () => {
  const res = proxy(req("/styles?reauth=1"));
  assert.equal(new URL(location(res)!).pathname, "/login");
});
