// Where a server-side gate sends a request that has no live session. PURE LEAF
// — the proxy imports it, so no server-only imports here.
//
// The proxy bounces a browser that still holds a session cookie off /login
// (to /styles), judging by the cookie alone. A cookie whose session row is
// gone — expired, revoked by a password reset, the user removed — is not a
// live session: /styles would send it straight back to /login, and the two
// redirect each other forever ("too many redirects"). The marker tells the
// proxy this request was sent by a server gate that already checked, so the
// sign-in form opens; signing in replaces the dead cookie.
export const REAUTH_PARAM = "reauth";
export const SIGN_IN_AGAIN = `/login?${REAUTH_PARAM}=1`;
